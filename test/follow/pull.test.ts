// TASK-A-073 (REQ-010 R8, AC-8): following Blueprint — the pull on start / every tick and Blueprint's push (/v1/notify).
// The Blueprint here is the fake serving RECORDED answers of a real blueprint-back with versions 1–3 of the worked seed
// (v2 changed STEP-004, v3 changed STEP-001); a synthetic feed (same shape) is used only where a test needs a case the recording lacks.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { writeEvent } from "../../src/core/write";
import { events, followState, projects } from "../../src/db/schema";
import { newCard, setup } from "../helpers/api";
import { BP_PROJECT } from "../helpers/fake-blueprint";

const feedOf = (versions: { version: number; changed?: string[]; removed?: string[]; added?: string[] }[]) => () => ({
  versions: versions.map((v) => ({
    version: v.version, confirmedAt: "2026-10-13T10:00:00.000Z", confirmedBy: "operator", summary: { parts: 0, links: 0, partsByKind: {} },
    changes: { added: v.added ?? [], changed: v.changed ?? [], removed: v.removed ?? [] },
  })),
  latest: { version: versions.at(-1)?.version ?? 1, confirmedAt: "2026-10-13T10:00:00.000Z" }, changedSinceLatest: false,
});

async function world() {
  const s = await setup();
  const project = (await s.call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT, version: 1 })).json;
  const card = async (key: string, version = 1) => (await newCard(s.call, project.id, { anchor: { key, version } })).json;
  const get = async (id: string) => (await s.call("GET", `/v1/cards/${id}`)).json;
  return { ...s, project, card, get, spec: async () => (await s.call("GET", `/v1/projects/${project.id}`)).json };
}

test("pull: a card whose anchor part changed in a newer version gets specChangedVersion (the newest) and stops being workable; the anchor is never edited", async () => {
  const w = await world();
  const a = await w.card("STEP-004"); // changed in v2
  const b = await w.card("STEP-001"); // changed in v3
  const c = await w.card("STEP-002"); // never changed
  await w.follow.pullAll();
  expect(await w.get(a.id)).toMatchObject({ specChangedVersion: 2, workable: false, anchor: { key: "STEP-004", version: 1 } });
  expect(await w.get(b.id)).toMatchObject({ specChangedVersion: 3, workable: false, anchor: { key: "STEP-001", version: 1 } });
  expect(await w.get(c.id)).toMatchObject({ specChangedVersion: null, workable: true });
  expect((await w.spec()).latestSeenVersion).toBe(3);
  const evs = (await w.db.select().from(events).where(eq(events.type, "card.spec_changed"))).map((e) => e.data);
  expect(evs).toEqual([{ version: 2, cardIds: [a.id] }, { version: 3, cardIds: [b.id] }]);
  expect((await w.call("POST", `/v1/projects/${w.project.id}/rebuild-check`)).json).toEqual({ same: true });
});

test("pull is idempotent and remembers where it got to: a second pull writes nothing; followState holds lastPulledVersion and lastPullAt", async () => {
  const w = await world();
  await w.card("STEP-004");
  await w.follow.pullAll();
  const count = async () => (await w.db.select().from(events)).length;
  const n = await count();
  await w.follow.pullAll();
  expect(await count()).toBe(n);
  const [fs] = await w.db.select().from(followState).where(eq(followState.projectId, w.project.id));
  expect(fs!.lastPulledVersion).toBe(3);
  expect(fs!.lastPullAt).toBeInstanceOf(Date);
  expect(w.fake.mode.calls.filter((c) => c.includes("versions?after=")).slice(-1)).toEqual([`GET /v1/projects/${BP_PROJECT}/versions?after=3`]);
});

test("a card anchored at version 2 is not flagged by v2 itself (anchorVersion < version), and the operator's clear sticks until a NEWER change", async () => {
  const w = await world();
  const atV2 = await w.card("STEP-004", 2);
  const atV1 = await w.card("STEP-004", 1);
  await w.follow.pullAll();
  expect((await w.get(atV2.id)).specChangedVersion).toBeNull();
  expect((await w.get(atV1.id)).specChangedVersion).toBe(2);
  await w.call("POST", `/v1/cards/${atV1.id}/spec-change/clear`);
  await w.follow.pullAll();
  expect((await w.get(atV1.id)).specChangedVersion).toBeNull(); // v2 was already seen — not re-flagged
  w.fake.mode.feed = feedOf([{ version: 4, changed: ["STEP-004"] }]);
  await w.follow.pullAll();
  expect((await w.get(atV1.id)).specChangedVersion).toBe(4);
  expect((await w.get(atV2.id)).specChangedVersion).toBe(4); // v4 > its anchor 2
});

test("`changed ∪ removed` both count; the newest version wins; a version that touches no card still advances latestSeenVersion (SYNTHETIC feed, recorded shape)", async () => {
  const w = await world();
  const removedOne = await w.card("STEP-005");
  const changedTwice = await w.card("STEP-006");
  w.fake.mode.feed = feedOf([
    { version: 2, changed: ["STEP-006"] }, { version: 3, removed: ["STEP-005"] }, { version: 4, changed: ["STEP-006"] }, { version: 5, added: ["STEP-099"] },
  ]);
  await w.follow.pullAll();
  expect((await w.get(removedOne.id)).specChangedVersion).toBe(3);
  expect((await w.get(changedTwice.id)).specChangedVersion).toBe(4);
  expect((await w.spec()).latestSeenVersion).toBe(5);
  const types = (await w.db.select().from(events).where(eq(events.type, "card.spec_changed"))).map((e) => (e.data as any).version);
  expect(types).toEqual([2, 3, 4, 5]); // one event per pulled version, the last with no card
});

test("Blueprint down: no throw, ONE codes-only log line, nothing changes; the next pull after it is back works", async () => {
  const w = await world();
  const a = await w.card("STEP-004");
  w.fake.mode.down = true;
  await w.follow.pullAll();
  expect(w.logs).toEqual(["[pull] blueprint_unreachable"]);
  expect((await w.get(a.id)).specChangedVersion).toBeNull();
  expect((await w.spec()).latestSeenVersion).toBe(1);
  w.fake.mode.down = false;
  await w.follow.pullAll();
  expect((await w.get(a.id)).specChangedVersion).toBe(2);
  expect(w.logs).toHaveLength(1);
});

test("push: POST /v1/notify answers 202 {} at once (no actor needed) and the same pull runs for every CAW project of that Blueprint project — the LEGACY duplicates (v1.15: the route no longer makes a second one)", async () => {
  const w = await world();
  // a second CAW project of the same Blueprint project, from v2: written as the event (the HTTP route refuses it since v1.15, but projects made before then exist)
  const secondId = crypto.randomUUID();
  await writeEvent(w.db, { type: "project.created", projectId: secondId, actor: "operator", at: new Date().toISOString(), data: { id: secondId, name: w.project.name, blueprintProjectId: BP_PROJECT, version: 2 } });
  const second = { id: secondId };
  const a = await w.card("STEP-004");
  const onSecond = (await newCard(w.call, second.id, { anchor: { key: "STEP-001", version: 2 } })).json;
  const r = await w.call("POST", "/v1/notify", { event: "version.confirmed", projectId: BP_PROJECT, version: 3, confirmedAt: "2026-10-13T10:00:00.000Z" }, null);
  expect([r.status, r.json]).toEqual([202, {}]);
  await w.follow.idle();
  expect((await w.get(a.id)).specChangedVersion).toBe(2); // the first project pulled v2 and v3
  expect((await w.get(onSecond.id)).specChangedVersion).toBe(3); // the second began at v2 and pulled only v3
  expect((await w.call("GET", `/v1/projects/${second.id}`)).json.latestSeenVersion).toBe(3);
});

test("notify: a malformed notice → 400 · a Blueprint project CAW does not follow → 202 and no pull", async () => {
  const w = await world();
  for (const body of [{}, { event: "something.else", projectId: BP_PROJECT, version: 3, confirmedAt: "x" }, { event: "version.confirmed", version: 3, confirmedAt: "x" }, { event: "version.confirmed", projectId: BP_PROJECT, version: 0, confirmedAt: "x" }]) {
    expect([JSON.stringify(body), (await w.call("POST", "/v1/notify", body, null)).status]).toEqual([JSON.stringify(body), 400]);
  }
  const before = w.fake.mode.calls.length;
  expect((await w.call("POST", "/v1/notify", { event: "version.confirmed", projectId: "nobody", version: 3, confirmedAt: "x" }, null)).status).toBe(202);
  await w.follow.idle();
  expect(w.fake.mode.calls.length).toBe(before);
});

test("on start: start() pulls at once, then every pollMs; pollMs 0 = one pull, no timer; stop() ends the timer (AC-8: a notice missed while CAW was down is found on start)", async () => {
  const w = await world();
  const a = await w.card("STEP-004");
  const stop0 = w.follow.start(0);
  await w.follow.idle();
  expect((await w.get(a.id)).specChangedVersion).toBe(2); // the pull on start
  const calls = () => w.fake.mode.calls.filter((c) => c.includes("versions?after=")).length;
  const n = calls();
  await Bun.sleep(80);
  expect(calls()).toBe(n); // no timer
  stop0();

  const stop = w.follow.start(20);
  await w.follow.idle();
  const b = await w.card("STEP-002");
  w.fake.mode.feed = feedOf([{ version: 4, changed: ["STEP-002"] }]);
  for (let i = 0; i < 50 && (await w.get(b.id)).specChangedVersion === null; i++) await Bun.sleep(20);
  expect((await w.get(b.id)).specChangedVersion).toBe(4); // found by a tick, not by a push
  stop();
  await Bun.sleep(60);
  const m = calls();
  await Bun.sleep(80);
  expect(calls()).toBe(m); // stopped
});

test("two pulls at once (a tick and a notice) do not double-write: the second sees the first's version", async () => {
  const w = await world();
  await w.card("STEP-004");
  await Promise.all([w.follow.pullAll(), w.follow.pullFor(BP_PROJECT), w.follow.pullAll()]);
  const evs = (await w.db.select().from(events).where(eq(events.type, "card.spec_changed"))).map((e) => (e.data as any).version);
  expect(evs).toEqual([2, 3]);
  void projects;
});
