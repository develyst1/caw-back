// TASK-A-078 / contract v1.5 (D-054): a `worker:<id>` writes on a card only FROM A RUNNING HOP of its own on that card —
// header `X-CAW-Hop: <hopId>`. Missing → 400 hop_required; not that worker's, not on that card, or already ended → 409
// hop_not_running { hopId, endedAt, outcome } and nothing written. operator / runner writes need no header. So an orphaned step
// of an interrupted hop (TEST-C-002 DEF-1: a card worked twice after `kill -9`) can no longer write.
import { expect, test } from "bun:test";
import { events } from "../../src/db/schema";
import { chainOf3, hopHeader, newCard, openHop, setup } from "../helpers/api";

async function world() {
  const s = await setup();
  const chain = await chainOf3(s.call);
  await s.call("POST", `/v1/projects/${chain.project.id}/chain/edges`, { from: chain.a.id, to: chain.b.id });
  const card = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id })).json;
  const hop = await openHop(s.call, chain.project.id, card.id, chain.a.id);
  const eventCount = async () => (await s.db.select().from(events)).length;
  const finish = (id: string, outcome = "commented") => s.call("PATCH", `/v1/hops/${id}`, { outcome }, "operator");
  return { ...s, ...chain, card, hop, eventCount, finish, as: `worker:${chain.a.id}` };
}

// the four guarded writes, as one request each (the hand-off goes ALONG the chain so a pass is a plain 200)
const writes = (w: { card: { id: string }; b: { id: string } }) => [
  ["comment", "POST", `/v1/cards/${w.card.id}/comments`, { text: "x" }],
  ["status", "PATCH", `/v1/cards/${w.card.id}/status`, { status: "doing" }],
  ["question", "POST", `/v1/cards/${w.card.id}/question`, { text: "q", proposedDefault: "d", cases: ["c"] }],
  ["hand-off", "POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: w.b.id, text: "ต่อ" }],
] as const;

test("no header → 400 hop_required, for comment, status, question and hand-off; nothing written", async () => {
  const w = await world();
  const n = await w.eventCount();
  for (const [name, method, path, body] of writes(w)) {
    const r = await w.call(method, path, body, w.as);
    expect([name, r.status, r.json.error.code]).toEqual([name, 400, "hop_required"]);
    const empty = await w.call(method, path, body, w.as, { "x-caw-hop": "" });
    expect([name, empty.status, empty.json.error.code]).toEqual([name, 400, "hop_required"]);
  }
  expect(await w.eventCount()).toBe(n);
});

test("a running hop of that worker on that card → every guarded write passes", async () => {
  const w = await world();
  for (const [name, method, path, body] of writes(w)) {
    if (name === "hand-off") continue; // moves the card away: last, below
    const r = await w.call(method, path, body, w.as, hopHeader(w.hop.id));
    expect([name, r.status < 300]).toEqual([name, true]);
  }
  const hand = await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: w.b.id, text: "ต่อ" }, w.as, hopHeader(w.hop.id));
  expect([hand.status, hand.json.assigneeId]).toEqual([200, w.b.id]);
});

test("a finished hop → 409 hop_not_running with { hopId, endedAt, outcome }, nothing written — an interrupted one too", async () => {
  const w = await world();
  await w.call("PATCH", `/v1/hops/${w.hop.id}`, { claim: "runner-gone" }, "operator");
  const fin = (await w.finish(w.hop.id, "interrupted")).json;
  const n = await w.eventCount();
  for (const [name, method, path, body] of writes(w)) {
    const r = await w.call(method, path, body, w.as, hopHeader(w.hop.id));
    expect([name, r.status, r.json.error.code, r.json.error.details]).toEqual([name, 409, "hop_not_running", { hopId: w.hop.id, endedAt: fin.endedAt, outcome: "interrupted" }]);
  }
  expect(await w.eventCount()).toBe(n);
});

test("a hop of another worker, of another card, or that does not exist → 409 hop_not_running, nothing written", async () => {
  const w = await world();
  const other = (await newCard(w.call, w.project.id, { assigneeId: w.a.id, title: "อีกใบ" })).json;
  await w.finish(w.hop.id);
  const hopOnOther = await openHop(w.call, w.project.id, other.id, w.a.id); // Ann's running hop, but on ANOTHER card
  const n = await w.eventCount();
  for (const [name, method, path, body] of writes(w)) {
    const wrongCard = await w.call(method, path, body, w.as, hopHeader(hopOnOther.id));
    expect([name, "card", wrongCard.status, wrongCard.json.error.code]).toEqual([name, "card", 409, "hop_not_running"]);
    expect(wrongCard.json.error.details).toEqual({ hopId: hopOnOther.id, endedAt: null, outcome: null }); // it runs — just not for this card
    const wrongWorker = await w.call(method, path, body, `worker:${w.b.id}`, hopHeader(hopOnOther.id)); // Ben presenting Ann's hop
    expect([name, "worker", wrongWorker.status, wrongWorker.json.error.code]).toEqual([name, "worker", 409, "hop_not_running"]);
    const ghost = await w.call(method, path, body, w.as, hopHeader("00000000-0000-4000-8000-0000000000aa"));
    expect([name, "ghost", ghost.status, ghost.json.error.code, ghost.json.error.details]).toEqual([name, "ghost", 409, "hop_not_running", { hopId: "00000000-0000-4000-8000-0000000000aa", endedAt: null, outcome: null }]);
    const junk = await w.call(method, path, body, w.as, hopHeader("not-a-uuid"));
    expect([name, "junk", junk.status, junk.json.error.code]).toEqual([name, "junk", 409, "hop_not_running"]);
  }
  expect(await w.eventCount()).toBe(n);
});

test("operator writes need no header; an operator's `X-CAW-Hop` is ignored", async () => {
  const w = await world();
  expect((await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "จากเจ้าของ" }, "operator")).status).toBe(201);
  expect((await w.call("PATCH", `/v1/cards/${w.card.id}/status`, { status: "review" }, "operator", hopHeader("anything"))).status).toBe(200);
});

test("a hand-off that fails the hop check is NOT recorded as a refused hand-off (v1.3 records only a hand-off from a running hop)", async () => {
  const w = await world();
  await w.finish(w.hop.id);
  const n = await w.eventCount();
  const r = await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: w.c.id, text: "ข้ามสาย" }, w.as, hopHeader(w.hop.id)); // off-chain AND from an ended hop
  expect([r.status, r.json.error.code]).toEqual([409, "hop_not_running"]);
  expect(await w.eventCount()).toBe(n);
  expect((await w.call("GET", `/v1/cards/${w.card.id}/context`)).json.notes).toEqual([]);
  // from a RUNNING hop the same off-chain request is recorded (control)
  const card2 = (await newCard(w.call, w.project.id, { assigneeId: w.a.id })).json;
  const hop2 = await openHop(w.call, w.project.id, card2.id, w.a.id);
  expect((await w.call("POST", `/v1/cards/${card2.id}/handoff`, { toWorkerId: w.c.id, text: "ข้ามสาย" }, w.as, hopHeader(hop2.id))).json.error.code).toBe("chain_broken");
  expect((await w.call("GET", `/v1/cards/${card2.id}/context`)).json.notes.map((x: any) => x.type)).toEqual(["handoff_refused"]);
});

test("a worker still cannot write on a card that is no longer its own, even from its running hop: 403 not_your_card (the guard comes first, then ownership)", async () => {
  const w = await world();
  await w.call("PATCH", `/v1/cards/${w.card.id}/assignee`, { workerId: w.b.id });
  const r = await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "x" }, w.as, hopHeader(w.hop.id));
  expect([r.status, r.json.error.code]).toEqual([403, "not_your_card"]);
});

test("the D-054 replay: hop A interrupted, hop B started on the same card — a late comment still carrying hop A → 409; hop B's comment → 201", async () => {
  const w = await world(); // hop A = w.hop, claimed by a runner that is then killed
  await w.call("PATCH", `/v1/hops/${w.hop.id}`, { claim: "runner-1" }, "operator");
  const interrupted = await w.finish(w.hop.id, "interrupted");
  expect(interrupted.status).toBe(200);
  const hopB = await openHop(w.call, w.project.id, w.card.id, w.a.id, { claim: "runner-2" });
  const n = await w.eventCount();
  const late = await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "ผลของ step ที่ค้างจาก hop A" }, w.as, hopHeader(w.hop.id));
  expect([late.status, late.json.error.code, late.json.error.details.outcome]).toEqual([409, "hop_not_running", "interrupted"]);
  expect(await w.eventCount()).toBe(n);
  expect((await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "จาก hop B" }, w.as, hopHeader(hopB.id))).status).toBe(201);
  expect((await w.call("GET", `/v1/cards/${w.card.id}/context`)).json.notes.map((x: any) => x.text)).toEqual(["จาก hop B"]);
});
