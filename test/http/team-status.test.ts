// TASK-A-093 / SPEC-A-009 § R1b + Revision 1 (REQ-015, contract v1.16): the runner checks in (POST /v1/runner/check-in { state: "running" | "stopping" },
// runner actor only, 204) and the screen asks GET /v1/team-status. The core keeps { name, lastSeenAt, state } IN MEMORY — process liveness, not project
// history — so a check-in writes no event and no table. `running` = the last check-in was `running` and is ≤ 45 s old; a `stopping` one makes it false
// at once. The clock is injected through createApp's `team` dependency.
import { expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { events } from "../../src/db/schema";
import { createTeamStatus } from "../../src/http/routes/team";
import { testDb } from "../helpers/db";

const START = "cd caw-back && bun run runner"; // the screen exists only while the API answers: only the runner is missing (D-103 DEF-1)

async function world() {
  const db = await testDb();
  const clock = { now: new Date("2026-10-20T10:00:00.000Z") };
  const app = createApp(db, { team: createTeamStatus(() => clock.now) });
  const call = async (method: string, path: string, body?: unknown, actor: string | null = "operator") => {
    const res = await app.request(path, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(actor === null ? {} : { "x-caw-actor": actor }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text(); // a 204 has no body
    return { status: res.status, json: text === "" ? null : JSON.parse(text) };
  };
  const status = async () => (await call("GET", "/v1/team-status", undefined, null)).json;
  const checkIn = (actor: string | null = "runner:r1", body: unknown = { state: "running" }) => call("POST", "/v1/runner/check-in", body, actor);
  const later = (seconds: number) => { clock.now = new Date(clock.now.getTime() + seconds * 1000); };
  const eventCount = async () => (await db.select().from(events)).length;
  return { db, app, call, status, checkIn, later, clock, eventCount };
}

test("a fresh API: not running, nobody seen, and the start command the screen shows", async () => {
  const w = await world();
  const r = await w.call("GET", "/v1/team-status", undefined, null); // a read: no actor needed
  expect([r.status, r.json]).toEqual([200, { running: false, runnerName: null, lastSeenAt: null, startCommand: START }]);
});

test("a `running` check-in as runner:r1 → 204, then team-status says running with the runner's name and the check-in time", async () => {
  const w = await world();
  const r = await w.checkIn();
  expect([r.status, r.json]).toEqual([204, null]);
  expect(await w.status()).toEqual({ running: true, runnerName: "r1", lastSeenAt: "2026-10-20T10:00:00.000Z", startCommand: START });
});

test("running is a `running` check-in in the last 45 s: 45.000 s still running, 45.001 s and 46 s not — and lastSeenAt is kept", async () => {
  const w = await world();
  await w.checkIn();
  w.later(15); // three of the runner's 15-s check-ins missed would be 45 s: 15 s is nothing
  expect((await w.status()).running).toBe(true);
  w.later(30);
  expect((await w.status()).running).toBe(true); // exactly 45.000 s
  w.later(0.001);
  expect((await w.status()).running).toBe(false);
  w.later(0.999); // 46 s after the check-in
  expect(await w.status()).toEqual({ running: false, runnerName: "r1", lastSeenAt: "2026-10-20T10:00:00.000Z", startCommand: START });
});

test("a `stopping` check-in makes running false AT ONCE, keeps the name, and moves lastSeenAt; a later `running` check-in makes it true again", async () => {
  const w = await world();
  await w.checkIn();
  expect((await w.status()).running).toBe(true);
  w.later(2);
  const stop = await w.checkIn("runner:r1", { state: "stopping" });
  expect(stop.status).toBe(204);
  expect(await w.status()).toEqual({ running: false, runnerName: "r1", lastSeenAt: "2026-10-20T10:00:02.000Z", startCommand: START });
  w.later(1);
  await w.checkIn();
  expect(await w.status()).toMatchObject({ running: true, runnerName: "r1", lastSeenAt: "2026-10-20T10:00:03.000Z" });
});

test("a later check-in moves lastSeenAt and makes it running again; the last runner to check in is the one named", async () => {
  const w = await world();
  await w.checkIn("runner:r1");
  w.later(50);
  expect((await w.status()).running).toBe(false);
  await w.checkIn("runner:r2");
  expect(await w.status()).toEqual({ running: true, runnerName: "r2", lastSeenAt: "2026-10-20T10:00:50.000Z", startCommand: START });
});

test("the state is required and checked: a missing body, no state, `paused`, a number, or a non-object → 400 validation, and nothing is recorded", async () => {
  const w = await world();
  for (const body of [undefined, {}, { state: "paused" }, { state: 1 }, { state: null }, { state: "RUNNING" }, "running", []]) {
    const r = await w.call("POST", "/v1/runner/check-in", body, "runner:r1");
    expect([JSON.stringify(body), r.status, r.json?.error?.code]).toEqual([JSON.stringify(body), 400, "validation"]);
  }
  expect(await w.status()).toEqual({ running: false, runnerName: null, lastSeenAt: null, startCommand: START });
});

test("only a runner checks in: the operator and a worker → 403 runner_only, nothing recorded; no actor → 400 actor_required", async () => {
  const w = await world();
  const worker = (await w.call("POST", "/v1/workers", { name: "Ann", roles: ["BE"], skills: ["s"] })).json;
  for (const actor of ["operator", `worker:${worker.id}`]) {
    const r = await w.checkIn(actor);
    expect([actor, r.status, r.json.error.code]).toEqual([actor, 403, "runner_only"]);
  }
  const none = await w.checkIn(null);
  expect([none.status, none.json.error.code]).toEqual([400, "actor_required"]);
  expect(await w.status()).toEqual({ running: false, runnerName: null, lastSeenAt: null, startCommand: START });
});

test("a check-in writes NO event and no table row — the events count is unchanged (the one exception to 'every write is an event', SPEC § R1b)", async () => {
  const w = await world();
  await w.call("POST", "/v1/workers", { name: "Seed", roles: ["BE"], skills: ["s"] }); // at least one event exists, so "unchanged" is not "zero"
  const before = await w.eventCount();
  for (let i = 0; i < 3; i++) { await w.checkIn(); w.later(5); }
  await w.checkIn("runner:r1", { state: "stopping" });
  expect(await w.eventCount()).toBe(before);
});

test("only `state` is read from the body: a name or a time sent with it is ignored — the name comes from the actor, the time from the core's clock", async () => {
  const w = await world();
  const r = await w.call("POST", "/v1/runner/check-in?name=evil&lastSeenAt=2001-01-01T00:00:00.000Z", { state: "running", name: "evil", lastSeenAt: "2001-01-01T00:00:00.000Z", running: false }, "runner:r1");
  expect(r.status).toBe(204);
  expect(await w.status()).toMatchObject({ running: true, runnerName: "r1", lastSeenAt: "2026-10-20T10:00:00.000Z" });
});

test("the status belongs to the app that made it: a second app starts empty (after an API restart it is empty until the next check-in)", async () => {
  const w = await world();
  await w.checkIn();
  const again = createApp(w.db, { team: createTeamStatus(() => w.clock.now) });
  const res = await again.request("/v1/team-status");
  expect(await res.json()).toEqual({ running: false, runnerName: null, lastSeenAt: null, startCommand: START });
  expect((await w.status()).running).toBe(true); // the first app is untouched
});

test("the runner is still refused on every other write (the check-in is the one route added to its list)", async () => {
  const w = await world();
  const r = await w.call("POST", "/v1/workers", { name: "x", roles: ["BE"], skills: ["s"] }, "runner:r1");
  expect([r.status, r.json.error.code]).toEqual([403, "runner_not_allowed"]);
});
