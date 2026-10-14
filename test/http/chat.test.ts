// TASK-A-079 / contract v1.4 (REQ-013): the project chat — the operator's messages, the entry worker's replies — chat hops and the
// new hop outcomes. A worker's chat writes need the running chat hop (X-CAW-Hop): missing → 400 hop_required, any other hop → 403 not_your_message.
import { expect, test } from "bun:test";
import { events } from "../../src/db/schema";
import { BP_PROJECT } from "../helpers/fake-blueprint";
import { chatHop, chatWorld, hopHeader, newCard, openHop, postChat, setup } from "../helpers/api";

async function world() {
  const s = await setup();
  const chain = await chatWorld(s.call);
  const P = `/v1/projects/${chain.project.id}`;
  const msg = (await postChat(s.call, chain.project.id)).json;
  return { ...s, ...chain, P, msg, as: `worker:${chain.a.id}` };
}

test("post: the operator → 201 ChatMessage; a worker 403 operator_only; text 1–4 000; unknown project 404; a runner is refused", async () => {
  const { call, project } = await setup().then(async (s) => ({ ...s, ...(await chatWorld(s.call)) }));
  const r = await postChat(call, project.id, "สวัสดี ผมอยากได้ระบบจองห้อง");
  expect(r.status).toBe(201);
  expect(r.json).toEqual({ id: r.json.id, projectId: project.id, author: "operator", text: "สวัสดี ผมอยากได้ระบบจองห้อง", replyTo: null, replyHopId: null, questions: null, proposalId: null, amendment: null, at: r.json.at, retryRequestedAt: null, chatHop: null });
  const P = `/v1/projects/${project.id}/chat`;
  expect((await call("POST", P, { text: "x" }, "worker:33333333-3333-4333-8333-333333333333")).json.error.code).toBe("unknown_worker");
  expect((await call("POST", P, { text: "" })).status).toBe(400);
  expect((await call("POST", P, { text: "x".repeat(4001) })).status).toBe(400);
  expect((await call("POST", P, { text: "x".repeat(4000) })).status).toBe(201);
  expect((await call("POST", "/v1/projects/00000000-0000-0000-0000-000000000099/chat", { text: "x" })).status).toBe(404);
  const run = await call("POST", P, { text: "x" }, "runner:r-1");
  expect([run.status, run.json.error.code]).toEqual([403, "runner_not_allowed"]);
});

test("a worker cannot post (403 operator_only)", async () => {
  const w = await world();
  const r = await w.call("POST", `${w.P}/chat`, { text: "ผมเป็น worker" }, w.as);
  expect([r.status, r.json.error.code]).toEqual([403, "operator_only"]);
});

test("list: oldest first, `after` (a message id), `limit` ≤ 200, 404", async () => {
  const w = await world();
  const m2 = (await postChat(w.call, w.project.id, "สอง")).json;
  const m3 = (await postChat(w.call, w.project.id, "สาม")).json;
  const ids = async (q = "") => (await w.call("GET", `${w.P}/chat${q}`)).json.messages.map((m: any) => m.id);
  expect(await ids()).toEqual([w.msg.id, m2.id, m3.id]);
  expect(await ids(`?after=${w.msg.id}`)).toEqual([m2.id, m3.id]);
  expect(await ids(`?after=${m3.id}`)).toEqual([]);
  expect(await ids("?limit=2")).toEqual([w.msg.id, m2.id]);
  expect((await w.call("GET", `${w.P}/chat?limit=201`)).status).toBe(400);
  expect((await w.call("GET", `${w.P}/chat?limit=0`)).status).toBe(400);
  expect((await w.call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/chat")).status).toBe(404);
});

test("a chat hop: exactly one of cardId / messageId; Hop.messageId set, cardId null; only the ENTRY worker; the message must be the operator's, and exist in this project", async () => {
  const w = await world();
  const card = (await newCard(w.call, w.project.id, { assigneeId: w.a.id })).json;
  const H = `${w.P}/hops`;
  expect((await w.call("POST", H, { workerId: w.a.id })).status).toBe(400); // neither
  expect((await w.call("POST", H, { workerId: w.a.id, cardId: card.id, messageId: w.msg.id })).status).toBe(400); // both
  const notEntry = await w.call("POST", H, { workerId: w.b.id, messageId: w.msg.id });
  expect([notEntry.status, notEntry.json.error.code]).toEqual([400, "not_entry_worker"]);
  expect((await w.call("POST", H, { workerId: w.a.id, messageId: "00000000-0000-0000-0000-000000000099" })).status).toBe(404);
  const hop = await w.call("POST", H, { workerId: w.a.id, messageId: w.msg.id });
  expect(hop.status).toBe(201);
  expect(hop.json).toMatchObject({ messageId: w.msg.id, cardId: null, workerId: w.a.id, locatedKeys: null, endedAt: null, outcome: null });
  // the project's one running hop rule holds across card and chat hops
  const second = await w.call("POST", H, { workerId: w.a.id, cardId: card.id });
  expect([second.status, second.json.error.code]).toEqual([409, "hop_running"]);
  // a card hop still has its shape: messageId null, locatedKeys null
  await w.call("PATCH", `/v1/hops/${hop.json.id}`, { outcome: "stopped" });
  const cardHop = await w.call("POST", H, { workerId: w.a.id, cardId: card.id });
  expect(cardHop.json).toMatchObject({ cardId: card.id, messageId: null, locatedKeys: null });
});

test("a chat hop needs an entry worker at all; no not_workable check; the claim rule as for cards; the budget does NOT apply (v1.8)", async () => {
  const s = await setup();
  const chain = await (await import("../helpers/api")).chainOf3(s.call); // no entry worker set
  const m = (await postChat(s.call, chain.project.id)).json;
  const r = await s.call("POST", `/v1/projects/${chain.project.id}/hops`, { workerId: chain.a.id, messageId: m.id });
  expect([r.status, r.json.error.code]).toEqual([400, "not_entry_worker"]);

  const w = await world();
  await w.call("PATCH", `${w.P}/mode`, { mode: "dispatcher", hopBudget: 1 });
  const hop = await chatHop(w.call, w.project.id, w.msg.id, w.a.id, { claim: "runner-1" });
  expect((await w.call("PATCH", `/v1/hops/${hop.id}`, { claim: "runner-2" })).json.error.code).toBe("already_claimed");
  await w.call("PATCH", `/v1/hops/${hop.id}`, { outcome: "replied" });
  const m2 = (await postChat(w.call, w.project.id, "อีกข้อความ")).json;
  const second = await w.call("POST", `${w.P}/hops`, { workerId: w.a.id, messageId: m2.id }); // hopBudget is 1 and one hop was used… by a CHAT hop, which does not count
  expect(second.status).toBe(201);
});

test("hop outcomes: replied · proposed · amended · proposed_and_amended finish a chat hop (which does not count in hopsUsed — v1.8)", async () => {
  const w = await world();
  const outcomes = ["replied", "proposed", "amended", "proposed_and_amended"];
  for (const [i, outcome] of outcomes.entries()) {
    const m = i === 0 ? w.msg : (await postChat(w.call, w.project.id, `ข้อความ ${i}`)).json;
    const hop = await chatHop(w.call, w.project.id, m.id, w.a.id);
    const done = await w.call("PATCH", `/v1/hops/${hop.id}`, { outcome });
    expect([outcome, done.status, done.json.outcome]).toEqual([outcome, 200, outcome]);
  }
  expect((await w.call("GET", w.P)).json.hopsUsed).toBe(0);
  expect((await w.call("PATCH", `/v1/hops/${(await chatHop(w.call, w.project.id, (await postChat(w.call, w.project.id, "x")).json.id, w.a.id)).id}`, { outcome: "nonsense" })).status).toBe(400);
});

test("context: the operator reads it; a worker only with its running chat hop on that message — missing header 400, any other hop 403 not_your_message", async () => {
  const w = await world();
  const m2 = (await postChat(w.call, w.project.id, "ข้อความสอง")).json;
  const hop = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  const C = `/v1/chat/${w.msg.id}/context`;
  const op = await w.call("GET", C);
  expect(op.status).toBe(200);
  expect(Object.keys(op.json).sort()).toEqual(["chain", "message", "project", "thread"]);
  expect(op.json.message.id).toBe(w.msg.id);
  expect(op.json.project.id).toBe(w.project.id);
  expect(op.json.chain.entryWorkerId).toBe(w.a.id);
  expect(op.json.thread.map((m: any) => m.id)).toEqual([w.msg.id]); // the chat up to and including this message
  expect((await w.call("GET", `/v1/chat/${m2.id}/context`)).json.thread.map((m: any) => m.id)).toEqual([w.msg.id, m2.id]);

  expect((await w.call("GET", C, undefined, w.as, hopHeader(hop.id))).status).toBe(200);
  const noHeader = await w.call("GET", C, undefined, w.as);
  expect([noHeader.status, noHeader.json.error.code]).toEqual([400, "hop_required"]);
  const otherMessage = await w.call("GET", `/v1/chat/${m2.id}/context`, undefined, w.as, hopHeader(hop.id)); // her hop is on msg 1
  expect([otherMessage.status, otherMessage.json.error.code]).toEqual([403, "not_your_message"]);
  const ben = await w.call("GET", C, undefined, `worker:${w.b.id}`, hopHeader(hop.id));
  expect([ben.status, ben.json.error.code]).toEqual([403, "not_your_message"]);
  const ghost = await w.call("GET", C, undefined, w.as, hopHeader("00000000-0000-4000-8000-0000000000aa"));
  expect([ghost.status, ghost.json.error.code, ghost.json.error.details]).toEqual([403, "not_your_message", { hopId: "00000000-0000-4000-8000-0000000000aa", endedAt: null, outcome: null }]);
  await w.call("PATCH", `/v1/hops/${hop.id}`, { outcome: "replied" });
  const ended = await w.call("GET", C, undefined, w.as, hopHeader(hop.id));
  expect([ended.status, ended.json.error.code, ended.json.error.details.outcome]).toEqual([403, "not_your_message", "replied"]);
  expect((await w.call("GET", "/v1/chat/00000000-0000-0000-0000-000000000099/context")).status).toBe(404);
  expect((await w.call("GET", "/v1/chat/not-a-uuid/context")).status).toBe(404);
});

test("reply: the worker from its running chat hop → 201 (author, replyTo), the asked message gets replyHopId; questions kept; the amendment link is built by CAW", async () => {
  const w = await world();
  const hop = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  const R = `/v1/chat/${w.msg.id}/reply`;
  const questions = [{ text: "ห้องใหญ่คือกี่คน", proposedDefault: "เกิน 10 คน", cases: ["10", "20"] }];
  const r = await w.call("POST", R, { text: "รับทราบ มีคำถามสองข้อ", questions, amendment: { blueprintMessageId: "bp-msg-1" } }, w.as, hopHeader(hop.id));
  expect(r.status).toBe(201);
  expect(r.json).toEqual({
    id: r.json.id, projectId: w.project.id, author: w.as, text: "รับทราบ มีคำถามสองข้อ", replyTo: w.msg.id, replyHopId: null, questions, proposalId: null,
    amendment: { blueprintMessageId: "bp-msg-1", link: `http://127.0.0.1:3100/p/${BP_PROJECT}/chat` }, at: r.json.at,
    retryRequestedAt: null, chatHop: null, // v1.9
  });
  const list = (await w.call("GET", `${w.P}/chat`)).json.messages;
  expect(list.map((m: any) => [m.author === "operator" ? "operator" : "worker", m.replyHopId])).toEqual([["operator", hop.id], ["worker", null]]);
  const twice = await w.call("POST", R, { text: "อีกที" }, w.as, hopHeader(hop.id));
  expect([twice.status, twice.json.error.code]).toEqual([409, "already_answered"]);
  // a new hop on an answered message is refused too
  await w.call("PATCH", `/v1/hops/${hop.id}`, { outcome: "replied" });
  const again = await w.call("POST", `${w.P}/hops`, { workerId: w.a.id, messageId: w.msg.id });
  expect([again.status, again.json.error.code]).toEqual([409, "already_answered"]);
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
});

test("reply errors: the operator → 403 not_your_message · no header 400 · another worker's / an ended hop 403 · text 1–4 000 · questions 1–10 cases · unknown proposalId 400 · a worker's own message is not answerable", async () => {
  const w = await world();
  const hop = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  const R = `/v1/chat/${w.msg.id}/reply`;
  const op = await w.call("POST", R, { text: "x" }, "operator");
  expect([op.status, op.json.error.code]).toEqual([403, "not_your_message"]);
  expect((await w.call("POST", R, { text: "x" }, w.as)).json.error.code).toBe("hop_required");
  expect((await w.call("POST", R, { text: "x" }, `worker:${w.b.id}`, hopHeader(hop.id))).json.error.code).toBe("not_your_message");
  expect((await w.call("POST", R, { text: "" }, w.as, hopHeader(hop.id))).status).toBe(400);
  expect((await w.call("POST", R, { text: "x".repeat(4001) }, w.as, hopHeader(hop.id))).status).toBe(400);
  expect((await w.call("POST", R, { text: "x", questions: [{ text: "q", proposedDefault: "d", cases: [] }] }, w.as, hopHeader(hop.id))).status).toBe(400);
  expect((await w.call("POST", R, { text: "x", questions: [{ text: "q", proposedDefault: "d", cases: Array.from({ length: 11 }, (_, i) => `c${i}`) }] }, w.as, hopHeader(hop.id))).status).toBe(400);
  const noProposal = await w.call("POST", R, { text: "x", proposalId: "00000000-0000-0000-0000-000000000099" }, w.as, hopHeader(hop.id));
  expect([noProposal.status, noProposal.json.error.code]).toEqual([400, "validation"]);
  const n = (await w.db.select().from(events)).length;
  expect((await w.call("POST", R, { text: "x", amendment: { blueprintMessageId: "" } }, w.as, hopHeader(hop.id))).status).toBe(400);
  expect((await w.db.select().from(events)).length).toBe(n); // every refusal wrote nothing
  await w.call("PATCH", `/v1/hops/${hop.id}`, { outcome: "failed" });
  expect((await w.call("POST", R, { text: "x" }, w.as, hopHeader(hop.id))).json.error.code).toBe("not_your_message");
  expect((await w.call("POST", "/v1/chat/00000000-0000-0000-0000-000000000099/reply", { text: "x" }, "operator")).status).toBe(404);
  void openHop;
});
