// TASK-A-078 / contract v1.3 (D-051): a hand-off refused 409 chain_broken is RECORDED on the card — one event
// `card.handoff_refused` → a note `handoff_refused` (from, to, allowed, text) in the card's context — and the 409 is answered as before.
import { expect, spyOn, test } from "bun:test";
import { events } from "../../src/db/schema";
import { chainOf3, hopHeader, newCard, openHop, setup } from "../helpers/api";

async function world() {
  const s = await setup();
  const chain = await chainOf3(s.call);
  await s.call("POST", `/v1/projects/${chain.project.id}/chain/edges`, { from: chain.a.id, to: chain.b.id }); // Ann → Ben only
  const card = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id })).json;
  const hop = await openHop(s.call, chain.project.id, card.id, chain.a.id);
  const eventCount = async () => (await s.db.select().from(events)).length;
  const notes = async () => (await s.call("GET", `/v1/cards/${card.id}/context`)).json.notes as any[];
  return { ...s, ...chain, card, hop, eventCount, notes, as: `worker:${chain.a.id}`, H: hopHeader(hop.id) };
}

test("an off-chain hand-off: the same 409 as before AND a handoff_refused note with from / to / allowed / text; the card is untouched", async () => {
  const w = await world();
  const before = (await w.call("GET", `/v1/cards/${w.card.id}`)).json;
  const r = await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: w.c.id, text: "ส่ง QA เลย" }, w.as, w.H);
  expect([r.status, r.json.error.code, r.json.error.details]).toEqual([409, "chain_broken", { from: w.a.id, allowed: [w.b.id] }]);
  expect(Object.keys(r.json)).toEqual(["error"]);
  expect(Object.keys(r.json.error).sort()).toEqual(["code", "details", "message"]);

  const note = (await w.notes()).at(-1);
  expect(note).toMatchObject({ type: "handoff_refused", actor: w.as, text: "ส่ง QA เลย", fromWorkerId: w.a.id, toWorkerId: w.c.id, allowed: [w.b.id] });
  expect(Object.keys(note).sort()).toEqual(["actor", "allowed", "at", "fromWorkerId", "id", "text", "toWorkerId", "type"]);
  expect((await w.call("GET", `/v1/cards/${w.card.id}`)).json).toEqual(before); // assignee, status, updatedAt: nothing moved
  const ev = (await w.db.select().from(events)).filter((e) => e.type === "card.handoff_refused");
  expect(ev).toHaveLength(1);
  // `noteId` is the server-made id of the note the event becomes (the reducer is pure: ids travel in the event)
  expect(ev[0]!.data).toEqual({ cardId: w.card.id, noteId: expect.any(String), from: w.a.id, to: w.c.id, allowed: [w.b.id], text: "ส่ง QA เลย" });
  expect((ev[0]!.data as { noteId: string }).noteId).toBe(note.id);
  expect(ev[0]!.actor).toBe(w.as);
});

test("the operator's refused hand-off is recorded too (the same rule, actor operator); each refusal is its own note, in time order among the others", async () => {
  const w = await world();
  await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "ก่อน" }, w.as, w.H);
  await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: w.c.id, text: "ลอง 1" }, w.as, w.H);
  await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "กลาง" }, w.as, w.H);
  const op = await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: w.c.id, text: "ลอง 2" }, "operator");
  expect(op.json.error.code).toBe("chain_broken");
  expect((await w.notes()).map((n) => [n.type, n.actor === "operator" ? "operator" : "worker", n.text])).toEqual([
    ["comment", "worker", "ก่อน"], ["handoff_refused", "worker", "ลอง 1"], ["comment", "worker", "กลาง"], ["handoff_refused", "operator", "ลอง 2"],
  ]);
  expect((await w.notes()).filter((n) => n.type !== "handoff_refused").every((n) => n.allowed === null)).toBe(true); // null for every other type
});

test("along the chain: no refused note; the hand-off works as before", async () => {
  const w = await world();
  const ok = await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: w.b.id, text: "ต่อ" }, w.as, w.H);
  expect([ok.status, ok.json.assigneeId]).toEqual([200, w.b.id]);
  expect((await w.notes()).map((n) => n.type)).toEqual(["handoff"]);
  expect((await w.db.select().from(events)).filter((e) => e.type === "card.handoff_refused")).toEqual([]);
});

test("no other refusal writes anything: 400 · 404 · not_your_card (event count before / after) — and none even TRIES to (nothing logged)", async () => {
  const w = await world();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const n = await w.eventCount();
  expect((await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: w.c.id, text: "" }, w.as, w.H)).status).toBe(400);
  expect((await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: w.c.id }, w.as, w.H)).status).toBe(400);
  expect((await w.call("POST", "/v1/cards/00000000-0000-0000-0000-000000000099/handoff", { toWorkerId: w.c.id, text: "x" }, w.as, w.H)).status).toBe(404);
  // not_your_card: the card was moved to Ben while Ann's hop was still running
  await w.call("PATCH", `/v1/cards/${w.card.id}/assignee`, { workerId: w.b.id });
  const n2 = await w.eventCount();
  const notYours = await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: w.c.id, text: "x" }, w.as, w.H);
  expect([notYours.status, notYours.json.error.code]).toEqual([403, "not_your_card"]);
  expect(await w.eventCount()).toBe(n2);
  expect(n2).toBe(n + 1); // only the operator's re-assign
  expect((await w.notes()).filter((x) => x.type === "handoff_refused")).toEqual([]);
  expect(logged).not.toHaveBeenCalled(); // a failed attempt to record would have been logged: there was no attempt
  logged.mockRestore();
});

test("rebuild-check stays same:true after a refusal", async () => {
  const w = await world();
  await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: w.c.id, text: "ไม่ได้" }, w.as, w.H);
  expect((await w.call("POST", `/v1/projects/${w.project.id}/rebuild-check`)).json).toEqual({ same: true });
});

test("a hand-off to an id that is no worker: refused 409 as before, nothing recorded (the note names a worker) — and never a 500", async () => {
  const w = await world();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const n = await w.eventCount();
  const r = await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: "00000000-0000-0000-0000-000000000099", text: "ถึงใครไม่รู้" }, w.as, w.H);
  expect([r.status, r.json.error.code, r.json.error.details.allowed]).toEqual([409, "chain_broken", [w.b.id]]);
  expect(logged).not.toHaveBeenCalled(); // skipped on purpose, not a recording that failed and was swallowed
  logged.mockRestore();
  expect(await w.eventCount()).toBe(n);
  expect((await w.notes()).filter((x) => x.type === "handoff_refused")).toEqual([]);
});
