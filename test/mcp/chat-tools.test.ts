// TASK-A-079 (REQ-013): the five chat tools of the MCP server — chat_context · locate · propose_cards · send_amendment · reply — one HTTP
// call each as worker:<CAW_WORKER_ID> with X-CAW-Hop = CAW_HOP_ID; and the whole walk of the entry worker's chat hop through them.
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server";
import { events } from "../../src/db/schema";
import { chatHop, chatWorld, postChat, setup } from "../helpers/api";
import { BP_PROJECT } from "../helpers/fake-blueprint";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function connect(app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, workerId: string, hopId?: string) {
  const server = createMcpServer({ apiUrl: "http://caw.test", workerId, hopId, fetch: (input, init) => Promise.resolve(app.request(new URL(input).pathname + new URL(input).search, init)) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { isError: r.isError === true, json, text };
  };
  return { client, call };
}

async function world() {
  const s = await setup();
  const chain = await chatWorld(s.call);
  const msg = (await postChat(s.call, chain.project.id)).json;
  const hop = await chatHop(s.call, chain.project.id, msg.id, chain.a.id);
  return { ...s, ...chain, msg, hop, P: `/v1/projects/${chain.project.id}` };
}

test("listTools: the five chat tools join the six — eleven in all, each with its required inputs", async () => {
  const w = await world();
  const { client } = await connect(w.app, w.a.id, w.hop.id);
  const tools = (await client.listTools()).tools;
  expect(tools.map((t) => t.name).sort()).toEqual(["ask_operator", "card_context", "chat_context", "comment", "hand_off", "locate", "my_cards", "propose_cards", "reply", "send_amendment", "set_status"]);
  const req = (name: string) => ((tools.find((t) => t.name === name)!.inputSchema as { required?: string[] }).required ?? []).sort();
  expect(req("chat_context")).toEqual(["messageId"]);
  expect(req("locate")).toEqual(["projectId", "request"]);
  expect(req("propose_cards")).toEqual(["items", "messageId", "projectId"]);
  expect(req("send_amendment")).toEqual(["projectId", "request"]);
  expect(req("reply")).toEqual(["messageId", "text"]);
  for (const t of tools) expect(t.description).toBeString();
});

test("the walk: operator posts → the entry worker's chat hop → chat_context → locate → propose_cards (2 items, one depends on the other) → reply with proposalId → operator accepts → 2 cards, dependency mapped, proposal accepted; a second proposal supersedes the first", async () => {
  const w = await world();
  const { call } = await connect(w.app, w.a.id, w.hop.id);

  const ctx = await call("chat_context", { messageId: w.msg.id });
  expect(ctx.isError).toBe(false);
  expect(Object.keys(ctx.json).sort()).toEqual(["chain", "message", "project", "thread"]);
  expect(ctx.json.message.text).toBe("อยากให้ห้องใหญ่ต้องอนุมัติ");
  expect(ctx.json.chain.entryWorkerId).toBe(w.a.id);

  const located = await call("locate", { projectId: w.project.id, request: "ห้องใหญ่ต้องอนุมัติ" });
  expect(located.isError).toBe(false);
  expect(located.json.candidates.map((c: any) => c.key)).toEqual(["DEC-001", "STEP-003", "STEP-004", "STEP-005"]);

  const items = [
    { title: "ทำหน้าอนุมัติ", todo: "ตาม STEP-004", anchor: { key: "STEP-004", version: 1 }, workerId: w.b.id, dependsOn: [1], hops: 2 },
    { title: "ทำกฎอนุมัติห้องใหญ่", todo: "ตาม DEC-001", anchor: { key: "DEC-001", version: 1 }, workerId: w.c.id, dependsOn: [], hops: 3 },
  ];
  const first = await call("propose_cards", { projectId: w.project.id, messageId: w.msg.id, items });
  expect(first.isError).toBe(false);
  expect(first.json).toMatchObject({ status: "open", hopsTotal: 5, version: 1 });
  const second = await call("propose_cards", { projectId: w.project.id, messageId: w.msg.id, items }); // the same two items again: it replaces the first
  expect(second.json).toMatchObject({ status: "open", hopsTotal: 5 });

  const replied = await call("reply", { messageId: w.msg.id, text: "เสนอ 1 งานแล้ว ดูในหน้าข้อเสนอ", proposalId: second.json.id, questions: [{ text: "ห้องใหญ่คือกี่คน", proposedDefault: "เกิน 10", cases: ["10", "20"] }] });
  expect(replied.isError).toBe(false);
  expect(replied.json).toMatchObject({ replyTo: w.msg.id, proposalId: second.json.id, author: `worker:${w.a.id}` });

  // the operator accepts the SECOND (the first was superseded)
  const list = (await w.call("GET", `${w.P}/proposals`)).json.proposals;
  expect(list.map((p: any) => p.status)).toEqual(["open", "superseded"]);
  const accepted = await w.call("POST", `/v1/proposals/${first.json.id}/accept`);
  expect([accepted.status, accepted.json.error.code]).toEqual([409, "not_open"]);
  const ok = await w.call("POST", `/v1/proposals/${second.json.id}/accept`);
  expect(ok.status).toBe(200);
  const cards = ok.json.cards;
  expect(cards.map((c: any) => [c.title, c.assigneeId])).toEqual([["ทำหน้าอนุมัติ", w.b.id], ["ทำกฎอนุมัติห้องใหญ่", w.c.id]]);
  expect(cards[0].dependsOn).toEqual([cards[1].id]); // item 0 depends on item 1 → mapped to the new card's id
  expect(cards.map((c: any) => c.workable)).toEqual([false, true]);
  expect((await w.call("GET", `${w.P}/proposals`)).json.proposals.map((p: any) => p.status)).toEqual(["accepted", "superseded"]);

  // the walk ends where the operator's accept leaves it: rebuild-check agrees with the tables after chat, hop.located, proposals and cards
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
  const types = new Set((await w.db.select({ type: events.type }).from(events)).map((e) => e.type));
  for (const t of ["chat.posted", "chat.replied", "hop.started", "hop.located", "proposal.made", "proposal.accepted", "card.created"]) expect([t, types.has(t)]).toEqual([t, true]);
});

test("send_amendment: Blueprint's Message as returned; `from` as specified — the hop's id; Blueprint's refusal is a tool error amendment_refused", async () => {
  const w = await world();
  const { call } = await connect(w.app, w.a.id, w.hop.id);
  const ok = await call("send_amendment", { projectId: w.project.id, request: "ขอเพิ่มเรื่องห้องประชุมกลางแจ้ง", about: ["STEP-004"] });
  expect(ok.isError).toBe(false);
  expect(ok.json).toMatchObject({ role: "caw", model: "caw" });
  expect(w.fake.mode.bodies.at(-1)!.body.from).toBe(`caw:${w.project.id}:${w.hop.id}`);
  const refused = await call("send_amendment", { projectId: w.project.id, request: "ขอ", about: ["NOPE-999"] });
  expect([refused.isError, refused.json.error.code]).toEqual([true, "amendment_refused"]);
  const sent = await call("reply", { messageId: w.msg.id, text: "ส่งคำขอแก้ spec ไปที่แชทของ Blueprint แล้ว", amendment: { blueprintMessageId: ok.json.id } });
  expect(sent.json.amendment).toEqual({ blueprintMessageId: ok.json.id, link: `http://127.0.0.1:3100/p/${BP_PROJECT}/chat` });
});

test("the tools carry the API's rules as tool errors: no CAW_HOP_ID → hop_required; another worker's hop → not_your_message; a key not located → anchor_not_located", async () => {
  const w = await world();
  const noHop = await connect(w.app, w.a.id);
  for (const [tool, args] of [
    ["chat_context", { messageId: w.msg.id }], ["locate", { projectId: w.project.id, request: "ห้อง" }],
    ["propose_cards", { projectId: w.project.id, messageId: w.msg.id, items: [{ title: "t", todo: "", anchor: { key: "STEP-004", version: 1 }, workerId: w.b.id, dependsOn: [], hops: 1 }] }],
    ["send_amendment", { projectId: w.project.id, request: "ขอ" }], ["reply", { messageId: w.msg.id, text: "x" }],
  ] as const) {
    const r = await noHop.call(tool, args);
    expect([tool, r.isError, r.json.error.code]).toEqual([tool, true, "hop_required"]);
  }
  const ben = await connect(w.app, w.b.id, w.hop.id); // Ben presenting Ann's chat hop
  expect((await ben.call("reply", { messageId: w.msg.id, text: "x" })).json.error.code).toBe("not_your_message");
  const ann = await connect(w.app, w.a.id, w.hop.id);
  const unlocated = await ann.call("propose_cards", { projectId: w.project.id, messageId: w.msg.id, items: [{ title: "t", todo: "", anchor: { key: "STEP-004", version: 1 }, workerId: w.b.id, dependsOn: [], hops: 1 }] });
  expect([unlocated.isError, unlocated.json.error.code, unlocated.json.error.details]).toEqual([true, "anchor_not_located", { keys: ["STEP-004"] }]);
  void events;
});
