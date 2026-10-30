// REQ-105 D12 (REQ-105 Q4, PM accepted 2026-10-29; TASK-115): a card whose anchor part was REMOVED from the spec.
// The pull records it (card.anchor_removed / card.anchor_restored), the card shows `anchorRemoved` and is not workable, its context answers 404 `anchor_removed`
// (a worker's own pinned hop still gets its pinned text), and a rebuild from the events equals the tables. The fake Blueprint's change sets are SYNTHETIC (SPEC-106 v2, until recorded).
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { events } from "../../src/db/schema";
import { chainOf3, hopHeader, newCard, openHop, setup } from "../helpers/api";

const as = (w: { id: string }) => `worker:${w.id}`;

async function world() {
  const s = await setup();
  const { project, a } = await chainOf3(s.call);
  const card = async (key: string) => (await newCard(s.call, project.id, { assigneeId: a.id, anchor: { key } })).json;
  const get = async (id: string) => (await s.call("GET", `/v1/cards/${id}`)).json;
  const set = (rev: number, over: { added?: string[]; changed?: string[]; removed?: string[] }) => {
    s.fake.mode.changes.push({ rev, at: "2026-10-29T07:00:00.000Z", by: "โด่ง", cause: "edit", added: over.added ?? [], changed: over.changed ?? [], removed: over.removed ?? [] });
    s.fake.mode.spec.revision = Math.max(s.fake.mode.spec.revision, rev);
  };
  const ofType = async (type: string) => (await s.db.select().from(events).where(eq(events.type, type))).map((e) => e.data as any);
  const rebuild = async () => (await s.call("POST", `/v1/projects/${project.id}/rebuild-check`)).json;
  return { ...s, project, a, card, get, set, ofType, rebuild };
}

test("removed: the pull records card.anchor_removed for the cards on that part only; they show anchorRemoved, are not workable, no hop starts; the context answers 404 anchor_removed; rebuild-check is clean", async () => {
  const w = await world();
  const onGone = await w.card("STEP-004");
  const onGone2 = await w.card("STEP-004");
  const other = await w.card("STEP-001");
  expect(await w.get(onGone.id)).toMatchObject({ anchorRemoved: false, workable: true });
  w.set(2, { removed: ["STEP-004"] });
  w.fake.mode.gone.add("STEP-004");
  await w.follow.pullAll();

  expect(await w.get(onGone.id)).toMatchObject({ anchorRemoved: true, workable: false, specChangedVersion: 2 });
  expect(await w.get(onGone2.id)).toMatchObject({ anchorRemoved: true, workable: false });
  expect(await w.get(other.id)).toMatchObject({ anchorRemoved: false, workable: true, specChangedVersion: null });
  const removed = await w.ofType("card.anchor_removed");
  expect(removed).toHaveLength(1); // one event for the set
  expect({ revision: removed[0].revision, cardIds: [...removed[0].cardIds].sort() }).toEqual({ revision: 2, cardIds: [onGone.id, onGone2.id].sort() });

  const ctx = await w.call("GET", `/v1/cards/${onGone.id}/context`);
  expect([ctx.status, ctx.json.error.code, ctx.json.error.message]).toEqual([404, "anchor_removed", "part STEP-004 was removed from the spec"]);
  const hop = await w.call("POST", `/v1/projects/${w.project.id}/hops`, { cardId: onGone.id, workerId: w.a.id });
  expect([hop.status, hop.json.error.code]).toEqual([409, "not_workable"]); // no hop starts on it
  expect((await w.call("GET", `/v1/cards/${other.id}/context`)).status).toBe(200); // the board's other cards still read
  expect(await w.rebuild()).toEqual({ same: true });
});

test("a worker's OWN pinned hop on the card still gets the text it started with after the part was removed (D5 wins); the operator and a hop-less worker get 404", async () => {
  const w = await world();
  const card = await w.card("STEP-004");
  const hop = await openHop(w.call, w.project.id, card.id, w.a.id); // pins the text
  w.set(2, { removed: ["STEP-004"] });
  w.fake.mode.gone.add("STEP-004");
  await w.follow.pullAll();
  expect((await w.get(card.id)).anchorRemoved).toBe(true);

  const mine = await w.call("GET", `/v1/cards/${card.id}/context`, undefined, as(w.a), hopHeader(hop.id));
  expect([mine.status, mine.json.specRead.pinned, typeof mine.json.spec.part.title]).toEqual([200, true, "string"]);
  expect((await w.call("GET", `/v1/cards/${card.id}/context`)).json.error.code).toBe("anchor_removed");
  expect((await w.call("GET", `/v1/cards/${card.id}/context`, undefined, as(w.a))).json.error.code).toBe("anchor_removed");
});

test("restored: a later set that lists the key in `added` writes card.anchor_restored — the card is workable again and its context reads", async () => {
  const w = await world();
  const card = await w.card("STEP-004");
  w.set(2, { removed: ["STEP-004"] });
  w.fake.mode.gone.add("STEP-004");
  await w.follow.pullAll();
  expect((await w.get(card.id)).anchorRemoved).toBe(true);

  w.fake.mode.gone.delete("STEP-004");
  w.set(3, { added: ["STEP-004"] });
  await w.follow.pullAll();
  expect(await w.get(card.id)).toMatchObject({ anchorRemoved: false, workable: true });
  expect(await w.ofType("card.anchor_restored")).toEqual([{ cardIds: [card.id], revision: 3 }]);
  expect((await w.call("GET", `/v1/cards/${card.id}/context`)).status).toBe(200);
  expect(await w.rebuild()).toEqual({ same: true });
  // nothing new → nothing more written
  await w.follow.pullAll();
  expect(await w.ofType("card.anchor_restored")).toHaveLength(1);
  expect(await w.ofType("card.anchor_removed")).toHaveLength(1);
});

test("removed and brought back inside ONE pull: the last set decides — no anchor event, the card never shows removed; removed then another part's change keeps it removed", async () => {
  const w = await world();
  const card = await w.card("STEP-004");
  const stays = await w.card("STEP-001");
  w.set(2, { removed: ["STEP-004"] });
  w.set(3, { added: ["STEP-004"], changed: ["STEP-001"] });
  await w.follow.pullAll();
  expect(await w.ofType("card.anchor_removed")).toEqual([]);
  expect(await w.ofType("card.anchor_restored")).toEqual([]);
  expect(await w.get(card.id)).toMatchObject({ anchorRemoved: false, workable: true });
  expect((await w.get(card.id)).specChangedVersion).toBe(3); // it was removed in set 2: the card's part DID change, the flag shows
  expect((await w.get(stays.id)).specChangedVersion).toBe(3);

  w.set(4, { removed: ["STEP-004"] });
  w.set(5, { changed: ["STEP-001"] });
  w.fake.mode.gone.add("STEP-004");
  await w.follow.pullAll();
  expect(await w.ofType("card.anchor_removed")).toEqual([{ cardIds: [card.id], revision: 4 }]);
  expect(await w.rebuild()).toEqual({ same: true });
});

test("the part is gone in Blueprint but the pull has not seen it yet: the context already answers 404 anchor_removed (it used to be 502 blueprint_unreachable)", async () => {
  const w = await world();
  const card = await w.card("STEP-004");
  w.fake.mode.gone.add("STEP-004"); // no change set yet, no pull
  const ctx = await w.call("GET", `/v1/cards/${card.id}/context`);
  expect([ctx.status, ctx.json.error.code]).toEqual([404, "anchor_removed"]);
  expect((await w.get(card.id)).anchorRemoved).toBe(false); // the card is marked only by the pull
});
