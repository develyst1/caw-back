// TASK-A-082 / contract v1.9 (D-057): a failed chat step can be retried. `ChatMessage.chatHop` is computed on read (the newest hop on
// the message), `retryRequestedAt` is stored (event chat.retry_requested) and cleared by the next hop.started on that message, and
// POST /v1/chat/{messageId}/retry is the operator's route to ask for it.
import { eq } from "drizzle-orm";
import { expect, test } from "bun:test";
import { events } from "../../src/db/schema";
import { chatHop, chatWorld, hopHeader, postChat, setup } from "../helpers/api";

async function world() {
  const s = await setup();
  const chain = await chatWorld(s.call);
  const P = `/v1/projects/${chain.project.id}`;
  const msg = (await postChat(s.call, chain.project.id)).json;
  const as = `worker:${chain.a.id}`;
  const retry = (id = msg.id, actor: string | null = "operator") => s.call("POST", `/v1/chat/${id}/retry`, undefined, actor);
  const fail = (hopId: string) => s.call("PATCH", `/v1/hops/${hopId}`, { outcome: "failed", note: "claude stopped" });
  const list = async () => (await s.call("GET", `${P}/chat`)).json.messages as any[];
  const mine = async () => (await list()).find((m) => m.id === msg.id);
  const retryEvents = async () => (await s.db.select().from(events).where(eq(events.type, "chat.retry_requested"))).map((e) => [e.actor, e.data]);
  return { ...s, ...chain, P, msg, as, retry, fail, list, mine, retryEvents };
}

test("chatHop is computed on read: null before any hop, then the running hop (endedAt null), then the finished one — a failed hop leaves the message unanswered", async () => {
  const w = await world();
  expect((await w.mine()).chatHop).toBeNull();
  const hop = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  expect((await w.mine()).chatHop).toEqual({ id: hop.id, endedAt: null, outcome: null });
  await w.fail(hop.id);
  const m = await w.mine();
  expect(m.chatHop).toEqual({ id: hop.id, endedAt: expect.any(String), outcome: "failed" });
  expect(m).toMatchObject({ replyHopId: null, retryRequestedAt: null });
  expect(await w.list()).toHaveLength(1); // no reply
});

test("chatHop is the NEWEST hop of the message when it has had several", async () => {
  const w = await world();
  const first = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  await w.fail(first.id);
  const second = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  expect((await w.mine()).chatHop).toEqual({ id: second.id, endedAt: null, outcome: null });
  await w.call("PATCH", `/v1/hops/${second.id}`, { outcome: "interrupted" });
  expect((await w.mine()).chatHop).toMatchObject({ id: second.id, outcome: "interrupted" });
});

test("every route that returns chat messages carries chatHop and retryRequestedAt: post · list · context (message and thread) · reply", async () => {
  const w = await world();
  const posted = await postChat(w.call, w.project.id, "ข้อความที่สอง");
  expect(posted.json).toMatchObject({ chatHop: null, retryRequestedAt: null });
  const hop = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  const ctx = (await w.call("GET", `/v1/chat/${w.msg.id}/context`)).json;
  expect(ctx.message).toMatchObject({ chatHop: { id: hop.id, endedAt: null, outcome: null }, retryRequestedAt: null });
  expect(ctx.thread.map((m: any) => [m.id, "chatHop" in m, "retryRequestedAt" in m])).toEqual([[w.msg.id, true, true]]);
  const reply = await w.call("POST", `/v1/chat/${w.msg.id}/reply`, { text: "ตอบแล้ว" }, w.as, hopHeader(hop.id));
  expect(reply.json).toMatchObject({ chatHop: null, retryRequestedAt: null }); // a reply is not an asked message: no hop of its own
  const l = await w.list();
  expect(l.every((m) => "chatHop" in m && "retryRequestedAt" in m)).toBe(true);
});

test("retry after a failed hop → 202 {}, retryRequestedAt set on the message, exactly one chat.retry_requested event { messageId } by the operator", async () => {
  const w = await world();
  const hop = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  await w.fail(hop.id);
  const r = await w.retry();
  expect([r.status, r.json]).toEqual([202, {}]);
  const m = await w.mine();
  expect(m.retryRequestedAt).toBeString();
  expect(Number.isNaN(Date.parse(m.retryRequestedAt))).toBe(false);
  expect(await w.retryEvents()).toEqual([["operator", { messageId: w.msg.id }]]);
  expect(m.chatHop).toMatchObject({ id: hop.id, outcome: "failed" }); // still the failed hop until a new one starts
});

test("retry is allowed on a message with no chat hop yet; a second retry before pick-up just moves retryRequestedAt (202 again)", async () => {
  const w = await world();
  expect((await w.retry()).status).toBe(202);
  const first = (await w.mine()).retryRequestedAt;
  await Bun.sleep(5);
  expect((await w.retry()).status).toBe(202);
  const second = (await w.mine()).retryRequestedAt;
  expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
  expect(await w.retryEvents()).toHaveLength(2);
});

test("the next hop.started on the message clears retryRequestedAt; a hop on ANOTHER message leaves it", async () => {
  const w = await world();
  const other = (await postChat(w.call, w.project.id, "อีกข้อความ")).json;
  const hop = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  await w.fail(hop.id);
  await w.retry();
  const otherHop = await chatHop(w.call, w.project.id, other.id, w.a.id);
  expect((await w.mine()).retryRequestedAt).toBeString(); // a hop on another message is not its pick-up
  await w.call("PATCH", `/v1/hops/${otherHop.id}`, { outcome: "failed" });
  const again = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  const m = await w.mine();
  expect(m.retryRequestedAt).toBeNull();
  expect(m.chatHop).toEqual({ id: again.id, endedAt: null, outcome: null });
});

test("retry refusals: answered → 409 already_answered · its hop running → 409 hop_running · a worker's reply → 400 not_operator_message", async () => {
  const w = await world();
  const hop = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  const running = await w.retry();
  expect([running.status, running.json.error.code]).toEqual([409, "hop_running"]);
  const reply = await w.call("POST", `/v1/chat/${w.msg.id}/reply`, { text: "ตอบแล้ว" }, w.as, hopHeader(hop.id));
  await w.call("PATCH", `/v1/hops/${hop.id}`, { outcome: "replied" });
  const answered = await w.retry();
  expect([answered.status, answered.json.error.code]).toEqual([409, "already_answered"]);
  const notOp = await w.retry(reply.json.id);
  expect([notOp.status, notOp.json.error.code]).toEqual([400, "not_operator_message"]);
  expect(await w.retryEvents()).toEqual([]); // none of the refusals wrote an event
  expect((await w.mine()).retryRequestedAt).toBeNull();
});

test("retry as a worker → 403 operator_only; a runner → 403 runner_not_allowed; no actor → 4xx; an unknown or non-uuid message → 404 — and nothing is written", async () => {
  const w = await world();
  const asWorker = await w.retry(w.msg.id, w.as);
  expect([asWorker.status, asWorker.json.error.code]).toEqual([403, "operator_only"]);
  const asRunner = await w.retry(w.msg.id, "runner:r1");
  expect([asRunner.status, asRunner.json.error.code]).toEqual([403, "runner_not_allowed"]); // a runner only reaches the runs / hops routes (v1.2)
  expect((await w.retry(w.msg.id, null)).status).toBeGreaterThanOrEqual(400);
  expect((await w.retry("00000000-0000-0000-0000-000000000099")).status).toBe(404);
  expect((await w.retry("not-a-uuid")).status).toBe(404);
  expect(await w.retryEvents()).toEqual([]);
});

test("rebuild-check is same:true after the whole sequence (fail → retry → retry → new hop → fail → retry → reply)", async () => {
  const w = await world();
  const h1 = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  await w.fail(h1.id);
  await w.retry();
  await w.retry();
  const h2 = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  await w.fail(h2.id);
  await w.retry();
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true }); // retryRequestedAt set
  const h3 = await chatHop(w.call, w.project.id, w.msg.id, w.a.id);
  await w.call("POST", `/v1/chat/${w.msg.id}/reply`, { text: "ในที่สุด" }, w.as, hopHeader(h3.id));
  await w.call("PATCH", `/v1/hops/${h3.id}`, { outcome: "replied" });
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true }); // cleared and answered
});
