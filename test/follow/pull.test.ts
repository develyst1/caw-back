// TASK-A-073 (REQ-010 R8, AC-8) → REQ-105 (SPEC-107 D6/D8/D10): following Blueprint by REVISION — the pull on start / every tick and Blueprint's push (/v1/notify).
// The Blueprint here is the fake. Its `/spec/changes` answers are SYNTHETIC (SPEC-106 v2 route 4, until recorded): a test puts change sets in `fake.mode.changes`
// and moves `fake.mode.spec.revision`. Nothing below is a recording.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { writeEvent } from "../../src/core/write";
import { cards, events, followState } from "../../src/db/schema";
import { newCard, setup } from "../helpers/api";
import { BP_PROJECT } from "../helpers/fake-blueprint";

async function world() {
  const s = await setup();
  const project = (await s.call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT })).json; // starts at revision 1, label v1
  const card = async (key: string) => (await newCard(s.call, project.id, { anchor: { key } })).json;
  const get = async (id: string) => (await s.call("GET", `/v1/cards/${id}`)).json;
  /** Blueprint saves a change set: the spec moves to `rev` */
  const edit = (rev: number, over: { added?: string[]; changed?: string[]; removed?: string[] }) => {
    s.fake.mode.changes.push({ rev, at: "2026-10-29T07:00:00.000Z", by: "โด่ง", cause: "edit", added: over.added ?? [], changed: over.changed ?? [], removed: over.removed ?? [] });
    s.fake.mode.spec.revision = Math.max(s.fake.mode.spec.revision, rev);
  };
  const revised = async () => (await s.db.select().from(events).where(eq(events.type, "spec.revised"))).map((e) => e.data as { revision: number; latestLabel: unknown; cardIds: string[] });
  const changeCalls = () => s.fake.mode.calls.filter((c) => c.includes("/spec/changes"));
  return { ...s, project, card, get, edit, revised, changeCalls, view: async () => (await s.call("GET", `/v1/projects/${project.id}`)).json };
}

test("pull: only cards whose anchor changed in a set NEWER than the card's anchor revision are flagged (the newest set's revision); they stay workable; the anchor is never edited", async () => {
  const w = await world();
  const a = await w.card("STEP-004"); // cut at revision 1; changed in set 2
  const b = await w.card("STEP-001"); // cut at revision 1; changed in set 3
  const untouched = await w.card("STEP-002");
  w.edit(2, { changed: ["STEP-004"] });
  w.edit(3, { changed: ["STEP-001"] });
  const late = await w.card("STEP-001"); // cut when the spec already stood at revision 3: set 3 is not newer than it
  await w.follow.pullAll();
  expect(await w.get(a.id)).toMatchObject({ specChangedVersion: 3, workable: true, anchor: { key: "STEP-004", version: 1 } });
  expect(await w.get(b.id)).toMatchObject({ specChangedVersion: 3, workable: true, anchor: { key: "STEP-001", version: 1 } });
  expect(await w.get(untouched.id)).toMatchObject({ specChangedVersion: null, workable: true });
  expect((await w.get(late.id)).specChangedVersion).toBeNull();
  const evs = await w.revised();
  expect(evs).toHaveLength(1); // ONE event per pull
  expect({ ...evs[0]!, cardIds: [...evs[0]!.cardIds].sort() }).toEqual({ revision: 3, latestLabel: { version: 1, label: "v1" }, cardIds: [a.id, b.id].sort() });
  expect((await w.view()).spec).toMatchObject({ revision: 3, reachable: true });
  expect((await w.call("POST", `/v1/projects/${w.project.id}/rebuild-check`)).json).toEqual({ same: true });
});

test("a change set that touches no card (and no new label) writes NO event — only follow_state moves; a second pull asks from the revision it got to and writes nothing", async () => {
  const w = await world();
  await w.card("STEP-004");
  w.edit(2, { changed: ["STEP-006"] });
  w.edit(3, { added: ["STEP-099"] });
  await w.follow.pullAll();
  expect(await w.revised()).toEqual([]);
  const n = (await w.db.select().from(events)).length;
  const [fs] = await w.db.select().from(followState).where(eq(followState.projectId, w.project.id));
  expect(fs).toMatchObject({ lastPulledRevision: 3, lastPullOk: true });
  expect(fs!.lastPullAt).toBeInstanceOf(Date);
  expect(w.changeCalls().at(-1)).toBe(`GET /v1/projects/${BP_PROJECT}/spec/changes?after=1`);
  await w.follow.pullAll();
  expect((await w.db.select().from(events)).length).toBe(n);
  expect(w.changeCalls().at(-1)).toBe(`GET /v1/projects/${BP_PROJECT}/spec/changes?after=3`);
});

test("a new label alone (no card flagged) writes ONE spec.revised with the label; the project follows it (the label is a tag)", async () => {
  const w = await world();
  const a = await w.card("STEP-004");
  w.edit(2, { added: ["STEP-099"] });
  w.fake.mode.spec.label = { version: 2, label: "ก่อนส่งลูกค้า" };
  await w.follow.pullAll();
  expect(await w.revised()).toEqual([{ revision: 2, latestLabel: { version: 2, label: "ก่อนส่งลูกค้า" }, cardIds: [] }]);
  expect(await w.view()).toMatchObject({ latestLabel: { version: 2, label: "ก่อนส่งลูกค้า" }, latestSeenVersion: 2 });
  expect((await w.get(a.id)).specChangedVersion).toBeNull();
  w.edit(3, { added: ["STEP-098"] });
  await w.follow.pullAll();
  expect(await w.revised()).toHaveLength(1); // the same label again is not news
  expect((await w.call("POST", `/v1/projects/${w.project.id}/rebuild-check`)).json).toEqual({ same: true });
});

test("`changed ∪ removed` both count; the newest set wins on a card; paging: `more: true` asks again from the last revision and ONE event comes out", async () => {
  const w = await world();
  const removedOne = await w.card("STEP-005");
  const changedTwice = await w.card("STEP-006");
  w.edit(2, { changed: ["STEP-006"] });
  w.edit(3, { removed: ["STEP-005"] });
  w.edit(4, { changed: ["STEP-006"] });
  w.fake.mode.pageSize = 1;
  await w.follow.pullAll();
  expect(w.changeCalls()).toEqual([1, 2, 3].map((after) => `GET /v1/projects/${BP_PROJECT}/spec/changes?after=${after}`));
  expect((await w.get(removedOne.id)).specChangedVersion).toBe(4); // one event, one revision: the newest set the pull saw
  expect((await w.get(changedTwice.id)).specChangedVersion).toBe(4);
  expect(await w.revised()).toHaveLength(1);
  expect((await w.view()).spec.revision).toBe(4);
});

test("the operator's clear sticks until a NEWER change set flags the card again", async () => {
  const w = await world();
  const a = await w.card("STEP-004");
  w.edit(2, { changed: ["STEP-004"] });
  await w.follow.pullAll();
  expect((await w.get(a.id)).specChangedVersion).toBe(2);
  await w.call("POST", `/v1/cards/${a.id}/spec-change/clear`);
  await w.follow.pullAll();
  expect((await w.get(a.id)).specChangedVersion).toBeNull(); // set 2 was already pulled — not re-flagged
  w.edit(3, { changed: ["STEP-004"] });
  await w.follow.pullAll();
  expect((await w.get(a.id)).specChangedVersion).toBe(3);
});

test("a card cut AFTER a change set is not flagged by it (anchor revision 2, set 2); an older card on a later set is", async () => {
  const w = await world();
  w.edit(2, { changed: ["STEP-004"] });
  const cutAt2 = await w.card("STEP-004"); // reads the spec at revision 2
  const older = await w.card("STEP-001");
  await w.db.update(cards).set({ anchorRevision: 1 }).where(eq(cards.id, older.id)); // made older by hand, for contrast
  w.edit(3, { changed: ["STEP-001"] });
  await w.follow.pullAll(); // pulls after=1: sets 2 and 3
  expect((await w.get(cutAt2.id)).specChangedVersion).toBeNull();
  expect((await w.get(older.id)).specChangedVersion).toBe(3);
});

test("Blueprint down: no throw, ONE codes-only log line, reachable false, nothing else moves; back up it catches up from the last revision with no restart (AC-5)", async () => {
  const w = await world();
  const a = await w.card("STEP-004");
  w.edit(2, { changed: ["STEP-004"] });
  w.fake.mode.down = true;
  await w.follow.pullAll();
  expect(w.logs).toEqual(["[pull] blueprint_unreachable"]);
  expect((await w.get(a.id)).specChangedVersion).toBeNull();
  expect((await w.view()).spec).toMatchObject({ revision: 1, reachable: false });
  w.fake.mode.down = false;
  await w.follow.pullAll();
  expect((await w.get(a.id)).specChangedVersion).toBe(2);
  expect((await w.view()).spec).toMatchObject({ revision: 2, reachable: true });
  expect(w.changeCalls().at(-1)).toBe(`GET /v1/projects/${BP_PROJECT}/spec/changes?after=1`); // from the last revision it had, not from 0
  expect(w.logs).toHaveLength(1);
});

test("a reply that is not a change feed counts as unreachable: nothing moves, reachable false, one log line", async () => {
  const w = await world();
  const a = await w.card("STEP-004");
  w.edit(2, { changed: ["STEP-004"] });
  w.fake.mode.changesBody = { revision: 2, changes: "nope" };
  await w.follow.pullAll();
  expect(w.logs).toEqual(["[pull] blueprint_unreachable"]);
  expect((await w.get(a.id)).specChangedVersion).toBeNull();
  expect((await w.view()).spec).toMatchObject({ revision: 1, reachable: false });
  w.fake.mode.changesBody = null;
  await w.follow.pullAll();
  expect((await w.get(a.id)).specChangedVersion).toBe(2); // the real feed, next tick
});

test("push: POST /v1/notify answers 202 {} at once (no actor needed) and the same pull runs for every CAW project of that Blueprint project — the LEGACY duplicates (v1.15: the route no longer makes a second one)", async () => {
  const w = await world();
  // a second CAW project of the same Blueprint project: written as the event (the HTTP route refuses it since v1.15, but projects made before then exist); no follow_state row → it pulls from revision 0
  const secondId = crypto.randomUUID();
  await writeEvent(w.db, { type: "project.created", projectId: secondId, actor: "operator", at: new Date().toISOString(), data: { id: secondId, name: w.project.name, blueprintProjectId: BP_PROJECT, version: 2 } }); // (blueprint_project_id, version) is unique: the old duplicate sits at another label number
  const a = await w.card("STEP-004");
  const onSecond = (await newCard(w.call, secondId, { anchor: { key: "STEP-001" } })).json;
  w.edit(2, { changed: ["STEP-004"] });
  w.edit(3, { changed: ["STEP-001"] });
  const r = await w.call("POST", "/v1/notify", { event: "spec.changed", projectId: BP_PROJECT, revision: 3, at: "2026-10-29T07:00:00Z" }, null);
  expect([r.status, r.json]).toEqual([202, {}]);
  await w.follow.idle();
  expect((await w.get(a.id)).specChangedVersion).toBe(3); // the first project pulled sets 2 and 3
  expect((await w.get(onSecond.id)).specChangedVersion).toBe(3); // the second began at 0 and pulled both
  expect((await w.call("GET", `/v1/projects/${secondId}`)).json.spec.revision).toBe(3);
});

test("on start: start() pulls at once, then every pollMs; pollMs 0 = one pull, no timer; stop() ends the timer (AC-8: a notice missed while CAW was down is found on start)", async () => {
  const w = await world();
  const a = await w.card("STEP-004");
  w.edit(2, { changed: ["STEP-004"] });
  const stop0 = w.follow.start(0);
  await w.follow.idle();
  expect((await w.get(a.id)).specChangedVersion).toBe(2); // the pull on start
  const n = w.changeCalls().length;
  await Bun.sleep(80);
  expect(w.changeCalls().length).toBe(n); // no timer
  stop0();

  const stop = w.follow.start(20);
  await w.follow.idle();
  const b = await w.card("STEP-002");
  w.edit(3, { changed: ["STEP-002"] });
  for (let i = 0; i < 50 && (await w.get(b.id)).specChangedVersion === null; i++) await Bun.sleep(20);
  expect((await w.get(b.id)).specChangedVersion).toBe(3); // found by a tick, not by a push
  stop();
  await Bun.sleep(60);
  const m = w.changeCalls().length;
  await Bun.sleep(80);
  expect(w.changeCalls().length).toBe(m); // stopped
});

test("two pulls at once (a tick and a notice) do not double-write: the second sees the first's revision", async () => {
  const w = await world();
  await w.card("STEP-004");
  w.edit(2, { changed: ["STEP-004"] });
  await Promise.all([w.follow.pullAll(), w.follow.pullFor(BP_PROJECT), w.follow.pullAll()]);
  expect(await w.revised()).toHaveLength(1);
});
