// TASK-A-085 / contract v1.11 (D-066): a running hop's heartbeat. `Hop.lastActivityAt` = startedAt at first, then moved by each
// `hop.heartbeat` event; POST /v1/hops/{hopId}/heartbeat is the runner's, the core stamps the time, and under 60 s old it writes nothing.
// The clock is moved with bun's setSystemTime (the core's now() reads Date).
import { eq } from "drizzle-orm";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { events } from "../../src/db/schema";
import { chainOf3, newCard, openHop, setup } from "../helpers/api";

afterEach(() => setSystemTime());

async function world() {
  const s = await setup();
  const chain = await chainOf3(s.call);
  const P = `/v1/projects/${chain.project.id}`;
  const card = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id })).json;
  const hop = (await s.call("POST", `${P}/hops`, { cardId: card.id, workerId: chain.a.id })).json as { id: string; startedAt: string; lastActivityAt: string };
  const beat = (id = hop.id, actor: string | null = "runner:r1", body?: object, query = "") => s.call("POST", `/v1/hops/${id}/heartbeat${query}`, body, actor);
  const at = (secondsAfterStart: number) => setSystemTime(new Date(Date.parse(hop.startedAt) + secondsAfterStart * 1000));
  const beats = async () => (await s.db.select().from(events).where(eq(events.type, "hop.heartbeat"))).map((e) => [e.actor, e.projectId, e.data]);
  const listed = async () => ((await s.call("GET", `${P}/hops`)).json.hops as any[]).find((h) => h.id === hop.id);
  return { ...s, ...chain, P, hop, beat, at, beats, listed };
}

test("a new hop's lastActivityAt is its startedAt (in the answer, and in the list)", async () => {
  const w = await world();
  expect(w.hop.lastActivityAt).toBe(w.hop.startedAt);
  expect((await w.listed()).lastActivityAt).toBe(w.hop.startedAt);
});

test("a heartbeat as a runner 61 s after the start → 200 with the new time, exactly one hop.heartbeat event { hopId } by that runner; the list and the events feed show it", async () => {
  const w = await world();
  w.at(61);
  const r = await w.beat();
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ lastActivityAt: new Date(Date.parse(w.hop.startedAt) + 61_000).toISOString() });
  expect(await w.beats()).toEqual([["runner:r1", w.project.id, { hopId: w.hop.id }]]);
  expect((await w.listed()).lastActivityAt).toBe(r.json.lastActivityAt);
  expect((await w.call("GET", `${w.P}/events`)).json.events.some((e: any) => e.type === "hop.heartbeat")).toBe(true);
});

test("the 60 s throttle: under 60 s old → 200 with the same value and NO new event; exactly 60 s → written; the 60 s counts from the last write, not from the last call", async () => {
  const w = await world();
  const early = await w.beat(); // right after the start: well under 60 s
  expect([early.status, early.json.lastActivityAt]).toEqual([200, w.hop.startedAt]);
  expect(await w.beats()).toEqual([]);

  w.at(59.999);
  expect((await w.beat()).json.lastActivityAt).toBe(w.hop.startedAt); // 59.999 s: still fresh
  expect(await w.beats()).toEqual([]);

  w.at(60);
  const first = await w.beat();
  expect(first.json.lastActivityAt).toBe(new Date(Date.parse(w.hop.startedAt) + 60_000).toISOString()); // 60 s: written
  expect(await w.beats()).toHaveLength(1);

  w.at(90);
  const again = await w.beat();
  expect([again.status, again.json.lastActivityAt]).toEqual([200, first.json.lastActivityAt]); // 30 s later: nothing new
  expect(await w.beats()).toHaveLength(1);

  w.at(121);
  const third = await w.beat();
  expect(third.json.lastActivityAt).toBe(new Date(Date.parse(w.hop.startedAt) + 121_000).toISOString()); // 61 s after the last write
  expect(await w.beats()).toHaveLength(2);
});

test("only a runner: the operator and a worker → 403 runner_only (for a real hop and for an unknown one); nothing written", async () => {
  const w = await world();
  w.at(61);
  for (const actor of ["operator", `worker:${w.a.id}`]) {
    const r = await w.beat(w.hop.id, actor);
    expect([actor, r.status, r.json.error.code]).toEqual([actor, 403, "runner_only"]);
  }
  expect((await w.beat("00000000-0000-4000-8000-000000000099", "operator")).json.error.code).toBe("runner_only");
  expect((await w.beat(w.hop.id, null)).status).toBe(400); // no actor at all
  expect(await w.beats()).toEqual([]);
});

test("refusals: a finished hop → 409 hop_not_running · an unknown id → 404 · a non-uuid id → 404 — and a runner is still refused on every other route", async () => {
  const w = await world();
  w.at(61);
  expect((await w.beat("00000000-0000-4000-8000-000000000099")).status).toBe(404);
  expect((await w.beat("not-a-uuid")).status).toBe(404);
  await w.call("PATCH", `/v1/hops/${w.hop.id}`, { outcome: "commented" });
  const done = await w.beat();
  expect([done.status, done.json.error.code]).toEqual([409, "hop_not_running"]);
  expect(await w.beats()).toEqual([]);
  const other = await w.call("POST", "/v1/workers", { name: "x", roles: ["FE"], skills: ["s"] }, "runner:r1");
  expect([other.status, other.json.error.code]).toEqual([403, "runner_not_allowed"]);
});

test("a time sent in the body or the query is ignored: the stamp is the core's now()", async () => {
  const w = await world();
  w.at(61);
  const lie = "2001-01-01T00:00:00.000Z";
  const r = await w.beat(w.hop.id, "runner:r1", { lastActivityAt: lie, at: lie, now: lie }, `?lastActivityAt=${lie}&at=${lie}`);
  expect(r.status).toBe(200);
  expect(r.json.lastActivityAt).toBe(new Date(Date.parse(w.hop.startedAt) + 61_000).toISOString());
  const [ev] = await w.db.select().from(events).where(eq(events.type, "hop.heartbeat"));
  expect(ev!.data).toEqual({ hopId: w.hop.id }); // the event carries nothing but the hop
});

test("rebuild-check is same:true after start → heartbeats → finish", async () => {
  const w = await world();
  w.at(61);
  await w.beat();
  w.at(130);
  await w.beat();
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
  await w.call("PATCH", `/v1/hops/${w.hop.id}`, { outcome: "commented" });
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
  expect((await w.listed()).lastActivityAt).toBe(new Date(Date.parse(w.hop.startedAt) + 130_000).toISOString()); // finishing does not move it
});

test("a chat hop has a heartbeat too (the same route, the same rules)", async () => {
  const s = await setup();
  const chain = await (await import("../helpers/api")).chatWorld(s.call);
  const { postChat, chatHop } = await import("../helpers/api");
  const msg = (await postChat(s.call, chain.project.id)).json;
  const hop = await chatHop(s.call, chain.project.id, msg.id, chain.a.id);
  setSystemTime(new Date(Date.now() + 61_000));
  const r = await s.call("POST", `/v1/hops/${hop.id}/heartbeat`, undefined, "runner:r1");
  expect(r.status).toBe(200);
  expect(typeof r.json.lastActivityAt).toBe("string");
});
