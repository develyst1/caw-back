// TASK-A-074 (REQ-010 R10, AC-9): the MCP server a worker is given — six tools, each one HTTP call to the CAW API as
// `X-CAW-Actor: worker:<CAW_WORKER_ID>` and (v1.5, D-054) `X-CAW-Hop: <CAW_HOP_ID>`, so the API's rules apply unchanged. Tested through the SDK's own client:
// in memory against an in-process app (PGlite, fake Blueprint with recorded answers), and once over real stdio.
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMcpServer } from "../../src/mcp/server";
import { chainOf3, newCard, openHop, setup } from "../helpers/api";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

/** a client connected in memory to a CAW MCP server acting as worker `workerId` over the in-process app */
async function connect(app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, workerId: string, hopId?: string) {
  const server = createMcpServer({
    apiUrl: "http://caw.test", workerId, hopId,
    fetch: (input, init) => Promise.resolve(app.request(new URL(input).pathname + new URL(input).search, init)),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]!.text;
    // a result of the API is JSON; an input the SDK itself refuses (before any API call) is plain text
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { isError: r.isError === true, json, text };
  };
  return { client, call };
}

async function world() {
  const s = await setup();
  const chain = await chainOf3(s.call);
  await s.call("POST", `/v1/projects/${chain.project.id}/chain/edges`, { from: chain.a.id, to: chain.b.id });
  const c1 = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id, title: "งานของ Ann" })).json;
  const hop = await openHop(s.call, chain.project.id, c1.id, chain.a.id); // Ann's running hop on c1 — what the runner would hand her as CAW_HOP_ID
  return { ...s, ...chain, c1, hop };
}

test("lists the tools with their input schemas — the six card tools (the chat tools are in chat-tools.test.ts)", async () => {
  const w = await world();
  const { client } = await connect(w.app, w.a.id);
  const tools = (await client.listTools()).tools;
  expect(tools.map((t) => t.name).sort()).toEqual(["ask_operator", "card_context", "chat_context", "comment", "hand_off", "locate", "my_cards", "propose_cards", "reply", "save_code_map", "send_amendment", "set_status"]); // 11 since v1.4, 12 with save_code_map (v1.16)
  const req = (name: string) => (tools.find((t) => t.name === name)!.inputSchema as { required?: string[] }).required ?? [];
  expect(req("my_cards")).toEqual([]);
  expect(req("card_context")).toEqual(["cardId"]);
  expect(req("comment").sort()).toEqual(["cardId", "text"]);
  expect(req("hand_off").sort()).toEqual(["cardId", "text", "toWorkerId"]);
  expect(req("set_status").sort()).toEqual(["cardId", "status"]);
  expect(req("ask_operator").sort()).toEqual(["cardId", "cases", "proposedDefault", "text"]);
  for (const t of tools) expect(t.description).toBeString();
});

test("my_cards: the worker's own cards, workable first, across projects — or one project; nobody else's", async () => {
  const w = await world();
  const second = (await w.call("POST", "/v1/projects", { blueprintProjectId: (await import("../helpers/fake-blueprint")).BP_PROJECT_2, version: 1 })).json; // a second Blueprint project (v1.15: one CAW project each)
  await w.call("POST", `/v1/projects/${second.id}/chain/members`, { workerId: w.a.id });
  const waiting = (await newCard(w.call, w.project.id, { assigneeId: w.a.id, dependsOn: [w.c1.id], title: "รอ c1" })).json; // not workable
  const other = (await newCard(w.call, second.id, { assigneeId: w.a.id, title: "โปรเจกต์สอง" })).json;
  await newCard(w.call, w.project.id, { assigneeId: w.b.id, title: "ของ Ben" });
  const { call } = await connect(w.app, w.a.id);

  const all = await call("my_cards");
  expect(all.isError).toBe(false);
  expect(all.json.cards.map((c: any) => [c.title, c.workable])).toEqual([["งานของ Ann", true], ["โปรเจกต์สอง", true], ["รอ c1", false]]);
  expect(all.json.cards.every((c: any) => c.assigneeId === w.a.id)).toBe(true);
  expect((await call("my_cards", { projectId: second.id })).json.cards.map((c: any) => c.id)).toEqual([other.id]);
  expect((await call("my_cards", { projectId: w.project.id })).json.cards.map((c: any) => c.id)).toEqual([w.c1.id, waiting.id]);
  expect((await (await connect(w.app, w.c.id)).call("my_cards")).json.cards).toEqual([]); // Cat has none
  const nf = await call("my_cards", { projectId: "00000000-0000-0000-0000-000000000099" });
  expect([nf.isError, nf.json.error.code]).toEqual([true, "not_found"]);
});

test("card_context: the API's CardContext — Blueprint's spec untouched, notes, decisions", async () => {
  const w = await world();
  const { call } = await connect(w.app, w.a.id, w.hop.id);
  await call("comment", { cardId: w.c1.id, text: "เริ่มอ่าน spec" });
  const r = await call("card_context", { cardId: w.c1.id });
  expect(r.isError).toBe(false);
  const direct = (await w.call("GET", `/v1/cards/${w.c1.id}/context`)).json;
  // was: toEqual(direct). REQ-105 (D5): the worker's own hop is given the text it started with (specRead.pinned true, its own readAt); the operator's direct call is the latest read (pinned false)
  expect({ ...r.json, specRead: undefined }).toEqual({ ...direct, specRead: undefined });
  expect(r.json.specRead).toMatchObject({ revision: 1, fromCache: false, pinned: true });
  expect(direct.specRead.pinned).toBe(false);
  expect(r.json.spec.part.key).toBe("STEP-004");
  expect(r.json.notes.map((n: any) => n.text)).toEqual(["เริ่มอ่าน spec"]);
  const missing = await call("card_context", { cardId: "00000000-0000-0000-0000-000000000099" });
  expect([missing.isError, missing.json.error.code]).toEqual([true, "not_found"]);
});

test("comment · set_status · hand_off · ask_operator: each one API call as this worker; the results are the API's JSON", async () => {
  const w = await world();
  const { call } = await connect(w.app, w.a.id, w.hop.id);

  const note = await call("comment", { cardId: w.c1.id, text: "ข้อสังเกต" });
  expect(note.json).toMatchObject({ type: "comment", actor: `worker:${w.a.id}`, text: "ข้อสังเกต" });

  const st = await call("set_status", { cardId: w.c1.id, status: "doing" });
  expect(st.json).toMatchObject({ id: w.c1.id, status: "doing" });
  const bad = await call("set_status", { cardId: w.c1.id, status: "blocked" }); // not in the enum: refused by the tool's schema, no API call
  expect([bad.isError, bad.text]).toEqual([true, expect.stringContaining("status")]);
  expect((await w.call("GET", `/v1/cards/${w.c1.id}`)).json.status).toBe("doing");

  const q = await call("ask_operator", { cardId: w.c1.id, text: "ห้องใหญ่ต้องอนุมัติไหม", proposedDefault: "ต้อง", cases: ["เล็ก", "ใหญ่"] });
  expect(q.isError).toBe(false);
  expect(q.json).toMatchObject({ kind: "question", assigneeId: null, question: { text: "ห้องใหญ่ต้องอนุมัติไหม", proposedDefault: "ต้อง", cases: ["เล็ก", "ใหญ่"] } });
  const waiting = await call("set_status", { cardId: w.c1.id, status: "doing" });
  expect([waiting.isError, waiting.json.error.code]).toEqual([true, "waiting_on_question"]); // the asking card now waits

  await w.call("POST", `/v1/cards/${q.json.id}/answer`, { answer: "ต้อง" });
  const hand = await call("hand_off", { cardId: w.c1.id, toWorkerId: w.b.id, text: "ทำหน้าจอต่อ" });
  expect(hand.json).toMatchObject({ id: w.c1.id, assigneeId: w.b.id });
  const events = (await w.call("GET", `/v1/projects/${w.project.id}/events?limit=500`)).json.events;
  expect(events.filter((e: any) => e.actor === `worker:${w.a.id}`).map((e: any) => e.type)).toEqual(["card.commented", "card.status_set", "card.question_opened", "card.handed_off"]);
});

test("the API's rules apply unchanged: no hop → hop_required; someone else's hop → hop_not_running; off the chain → chain_broken with allowed; a card that moved → not_your_card — all as tool errors", async () => {
  const w = await world();
  const writes = [
    ["comment", { cardId: w.c1.id, text: "x" }], ["set_status", { cardId: w.c1.id, status: "done" }],
    ["hand_off", { cardId: w.c1.id, toWorkerId: w.c.id, text: "x" }], ["ask_operator", { cardId: w.c1.id, text: "t", proposedDefault: "d", cases: ["c"] }],
  ] as const;
  const noHop = await connect(w.app, w.b.id); // no CAW_HOP_ID at all
  for (const [tool, args] of writes) {
    const r = await noHop.call(tool, args);
    expect([tool, r.isError, r.json.error.code]).toEqual([tool, true, "hop_required"]);
  }
  const ben = await connect(w.app, w.b.id, w.hop.id); // Ben presenting Ann's hop
  for (const [tool, args] of writes) {
    const r = await ben.call(tool, args);
    expect([tool, r.isError, r.json.error.code]).toEqual([tool, true, "hop_not_running"]);
  }
  const ann = await connect(w.app, w.a.id, w.hop.id);
  const broken = await ann.call("hand_off", { cardId: w.c1.id, toWorkerId: w.c.id, text: "ส่ง QA" }); // Ann → Cat has no edge
  expect([broken.isError, broken.json.error.code, broken.json.error.details]).toEqual([true, "chain_broken", { from: w.a.id, allowed: [w.b.id] }]);
  // the card moves to Ben while Ann's hop still runs: her hop passes the hop check, the card is no longer hers
  await w.call("PATCH", `/v1/cards/${w.c1.id}/assignee`, { workerId: w.b.id });
  for (const [tool, args] of writes) {
    const r = await ann.call(tool, args);
    expect([tool, r.isError, r.json.error.code]).toEqual([tool, true, "not_your_card"]);
  }
});

test("CAW_HOP_ID: the writes carry it as X-CAW-Hop; the reads need nothing; without it every write tool answers hop_required", async () => {
  const w = await world();
  const noHop = await connect(w.app, w.a.id);
  expect((await noHop.call("my_cards")).isError).toBe(false);
  expect((await noHop.call("card_context", { cardId: w.c1.id })).isError).toBe(false);
  const refused = await noHop.call("comment", { cardId: w.c1.id, text: "ไม่มี hop" });
  expect([refused.isError, refused.json.error.code]).toEqual([true, "hop_required"]);
  const withHop = await connect(w.app, w.a.id, w.hop.id);
  expect((await withHop.call("comment", { cardId: w.c1.id, text: "มี hop" })).json).toMatchObject({ type: "comment", text: "มี hop" });
  // the hop ends (the runner finished it): the same server can no longer write
  await w.call("PATCH", `/v1/hops/${w.hop.id}`, { outcome: "commented" });
  const late = await withHop.call("comment", { cardId: w.c1.id, text: "ช้าไป" });
  expect([late.isError, late.json.error.code, late.json.error.details.outcome]).toEqual([true, "hop_not_running", "commented"]);
});

test("a worker CAW does not know: writes come back as the unknown_worker tool error", async () => {
  const w = await world();
  const ghost = await connect(w.app, "33333333-3333-4333-8333-333333333333");
  const r = await ghost.call("comment", { cardId: w.c1.id, text: "x" });
  expect([r.isError, r.json.error.code]).toEqual([true, "unknown_worker"]);
});

test("CAW unreachable → a tool error caw_unreachable, not a crash", async () => {
  const w = await world();
  const server = createMcpServer({ apiUrl: "http://127.0.0.1:1", workerId: w.a.id });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(() => client.close());
  const r = await client.callTool({ name: "card_context", arguments: { cardId: w.c1.id } });
  expect(r.isError).toBe(true);
  expect(JSON.parse((r.content as { text: string }[])[0]!.text).error.code).toBe("caw_unreachable");
});

test("over real stdio: `bun run src/mcp/server.ts` with CAW_API_URL + CAW_WORKER_ID lists the tools and runs my_cards against a running CAW API", async () => {
  const w = await world();
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: w.app.fetch });
  closers.push(() => api.stop(true));
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["run", "src/mcp/server.ts"], cwd: new URL("../..", import.meta.url).pathname,
    env: { ...(process.env as Record<string, string>), CAW_API_URL: `http://127.0.0.1:${api.port}`, CAW_WORKER_ID: w.a.id, CAW_HOP_ID: w.hop.id },
  });
  const client = new Client({ name: "stdio-test", version: "1" });
  await client.connect(transport);
  closers.push(() => client.close());
  expect((await client.listTools()).tools).toHaveLength(12); // 11 until save_code_map (v1.16)
  const r = await client.callTool({ name: "my_cards", arguments: {} });
  const cards = JSON.parse((r.content as { text: string }[])[0]!.text).cards;
  expect(cards.map((c: any) => c.title)).toEqual(["งานของ Ann"]);
  // CAW_HOP_ID reaches the API as X-CAW-Hop: a write over real stdio works
  const c = await client.callTool({ name: "comment", arguments: { cardId: w.c1.id, text: "จาก stdio" } });
  expect(c.isError).not.toBe(true);
  expect(JSON.parse((c.content as { text: string }[])[0]!.text)).toMatchObject({ type: "comment", text: "จาก stdio", actor: `worker:${w.a.id}` });
});

test("CAW_WORKER_ID is required: without it the server refuses to start — one line, exit 1", async () => {
  const env = { ...(process.env as Record<string, string>) };
  delete env.CAW_WORKER_ID;
  const run = async (value: string | undefined) => {
    const proc = Bun.spawn([process.execPath, "run", "src/mcp/server.ts"], { cwd: new URL("../..", import.meta.url).pathname, env: { ...env, ...(value === undefined ? {} : { CAW_WORKER_ID: value }) }, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const err = (await new Response(proc.stderr).text()).trim().split("\n").filter((l) => !l.startsWith("error: script"));
    return { value, code, lines: err.length, first: err[0] };
  };
  for (const r of await Promise.all([run(undefined), run("")])) { // both at once: two process starts, not two in a row
    expect([r.value, r.code, r.lines]).toEqual([r.value, 1, 1]);
    expect(r.first).toContain("CAW_WORKER_ID");
  }
});

// ---- TASK-A-088 / contract v1.13 (D-078): the MCP `comment` turns a typed backslash + n into a real line break; nothing else does ----
const BS_N = "\\n"; // the two characters backslash and n, as the model types them (the trace in TASK-C-039)
const notesOf = async (w: Awaited<ReturnType<typeof world>>) => ((await w.call("GET", `/v1/cards/${w.c1.id}/context`)).json.notes as { text: string; type: string }[]).map((n) => n.text);

test("v1.13: MCP comment with `a\\n\\nb` (backslash-n twice) stores a, two real line breaks, b — read back through the API", async () => {
  const w = await world();
  const { call } = await connect(w.app, w.a.id, w.hop.id);
  const typed = `a${BS_N}${BS_N}b`;
  expect(typed).toHaveLength(6); // a, backslash, n, backslash, n, b — what the model sends: no real line feed in it
  const note = await call("comment", { cardId: w.c1.id, text: typed });
  expect(note.isError).toBe(false);
  expect(note.json.text).toBe("a\n\nb");
  expect(await notesOf(w)).toEqual(["a\n\nb"]);
  const mixed = await call("comment", { cardId: w.c1.id, text: `บรรทัดแรก${BS_N}บรรทัดสอง\nบรรทัดสามจริง${BS_N}` }); // typed pairs and a real line feed together
  expect(mixed.json.text).toBe("บรรทัดแรก\nบรรทัดสอง\nบรรทัดสามจริง\n");
});

test("v1.13: MCP comment text without a backslash-n pair is stored byte for byte (Thai, real newline, tab, other backslashes, a lone backslash)", async () => {
  const w = await world();
  const { call } = await connect(w.app, w.a.id, w.hop.id);
  const texts = ["ข้อสังเกตธรรมดา", "สองบรรทัด\nจริง\tและแท็บ", "path C:\\temp\\x and a tab escape \\t and a lone \\", "  spaces  kept  ", "n alone, slash/n, \\ n"];
  for (const t of texts) expect((await call("comment", { cardId: w.c1.id, text: t })).json.text).toBe(t);
  expect(await notesOf(w)).toEqual(texts);
});

test("v1.13: the HTTP API stores text as sent — the operator's own comment with a literal backslash-n pair is unchanged", async () => {
  const w = await world();
  const r = await w.call("POST", `/v1/cards/${w.c1.id}/comments`, { text: `a${BS_N}b` }, "operator");
  expect([r.status, r.json.text]).toEqual([201, `a${BS_N}b`]);
  expect(await notesOf(w)).toEqual([`a${BS_N}b`]);
});

test("v1.13 scope: hand_off and ask_operator are NOT converted (D-078 asked for reply and comment only) — asserted so nobody widens it by accident", async () => {
  const w = await world();
  const { call } = await connect(w.app, w.a.id, w.hop.id);
  const handed = await call("hand_off", { cardId: w.c1.id, toWorkerId: w.b.id, text: `ส่ง${BS_N}ต่อ` });
  expect(handed.isError).toBe(false);
  expect(await notesOf(w)).toContain(`ส่ง${BS_N}ต่อ`); // the hand-off note keeps its literal pair
  const w2 = await world();
  const { call: call2 } = await connect(w2.app, w2.a.id, w2.hop.id);
  const q = await call2("ask_operator", { cardId: w2.c1.id, text: `ห้อง${BS_N}ใหญ่ไหม`, proposedDefault: `ต้อง${BS_N}`, cases: [`เล็ก${BS_N}`, "ใหญ่"] });
  expect(q.isError).toBe(false);
  expect(q.json.question).toEqual({ text: `ห้อง${BS_N}ใหญ่ไหม`, proposedDefault: `ต้อง${BS_N}`, cases: [`เล็ก${BS_N}`, "ใหญ่"] });
});
