// The runner's tick (manual mode only in TASK-C-030) against the real app on PGlite and a fake `claude`.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainOf3, newCard, setup } from "../../test/helpers/api";
import { RunnerApiError, createApi } from "./api";
import { type HopFile, type Procs, readHopFile, writeHopFile } from "./procs";
import { HOOKS } from "./config";
import type { HopDeps } from "./hop";
import { createCheckIn, createRunner } from "./main";
import { type FakeChild, fakeChild, fixture, hopAware, limitFixture } from "./testkit";
import { formatReset } from "./thai";

const made: string[] = []; // every temp folder a test makes, removed in afterAll
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const WS = tmp("caw-main-ws-");
mkdirSync(join(WS, ".claude/skills/role-be"), { recursive: true });
writeFileSync(join(WS, ".claude/skills/role-be/SKILL.md"), "BE craft");

/** no process exists, no group is alive — what the runner sees when nothing was left behind */
const noProcs: Procs = { inspect: () => null, groupAlive: () => false, killGroup: () => {}, sleep: async () => {} };

/** the runner's base settings file, which every hop extends with its own read fence (TASK-C-042) */
const baseSettings = join(tmp("caw-main-base-"), "settings.json");
writeFileSync(baseSettings, JSON.stringify({ permissions: { allow: [], deny: [] }, sandbox: { enabled: true }, hooks: { PreToolUse: [] } }));

async function world() {
  const t0 = await setup();
  const t = { ...t0, call: hopAware(t0.call) }; // a worker's write names its running hop (contract v1.5)
  const { project } = await chainOf3(t.call);
  const worker = (await t.call("POST", "/v1/workers", { name: "Blew", role: "BE", skills: ["role-be"], model: "haiku", effort: "low" })).json;
  await t.call("POST", `/v1/projects/${project.id}/chain/members`, { workerId: worker.id });
  await t.call("PATCH", `/v1/projects/${project.id}/workspace`, { roots: [tmp("caw-main-root-")] });
  const card = (await newCard(t.call, project.id, { assigneeId: worker.id })).json;
  const api = createApi("http://caw.test", "runner:test", (url, init) => t.app.fetch(new Request(url, init)));
  const actor = `worker:${worker.id}`;
  const spawned: string[][] = [];
  const children: FakeChild[] = [];
  let make: (cmd: string[]) => FakeChild = () => fakeChild({ lines: fixture("ok"), before: async () => { await t.call("POST", `/v1/cards/${card.id}/comments`, { text: "done" }, actor); } });
  const log: string[] = [];
  const mkDeps = (): HopDeps => ({
    api, tmpRoot: tmp("caw-main-tmp-"), hopsDir: hopsDir, procs: noProcs, log: (l) => log.push(l), cursors: new Map(), settingsFile: baseSettings,
    config: { apiUrl: "http://127.0.0.1:4530", pollMs: 10, hopMaxMs: 5000, claudeBin: "/bin/claude", workspaceRoot: WS, hooks: HOOKS.map((h) => `${WS}/scripts/hooks/${h}`) },
    spawn: (cmd) => { spawned.push(cmd); const c = make(cmd); children.push(c); return c; },
  });
  const hopsDir = tmp("caw-main-hops-"); // never the real <tmpdir>/caw-runner/hops
  const hops = () => api.hops(project.id);
  /** what the screen's "ให้ทำต่อ" does: the OPERATOR starts a hop, with no claim */
  const screenStart = async () => (await t.call("POST", `/v1/projects/${project.id}/hops`, { cardId: card.id, workerId: worker.id }, "operator")).json;
  return { ...t, hopsDir, screenStart, api, project, worker, card, actor, spawned, children, log, mkDeps, hops, set: (f: (cmd: string[]) => FakeChild) => { make = f; } };
}

describe("tick — manual mode", () => {
  test("a hop started from the screen (no claim) is claimed by this runner, run, and finished", async () => {
    const w = await world();
    const runner = createRunner({ ...w.mkDeps(), instance: "inst-A" });
    const started = await w.screenStart(); // as the screen's "ให้ทำต่อ" would: the OPERATOR starts it, with no claim
    expect(started.claimedBy).toBeNull();
    await runner.tick();
    await runner.idle();
    const [h, ...rest] = await w.hops();
    expect(rest).toEqual([]);
    expect([h!.id, h!.claimedBy, h!.outcome]).toEqual([started.id, "inst-A", "commented"]);
    expect(h!.tokensIn).toBeGreaterThan(0);
    expect(w.spawned).toHaveLength(1);
    const events = (await w.api.events(w.project.id, 0, 500)).filter((e) => e.type === "hop.claimed" || e.type === "hop.finished");
    expect(events.map((e) => e.actor)).toEqual(["runner:test", "runner:test"]); // the runner's writes are the runner's, not a worker's (contract v1.2)
  });

  test("nothing running → nothing happens (the runner never starts a hop of its own in manual mode)", async () => {
    const w = await world();
    const runner = createRunner({ ...w.mkDeps(), instance: "inst-A" });
    await runner.tick();
    await runner.idle();
    expect(await w.hops()).toEqual([]);
    expect(w.spawned).toHaveLength(0);
  });

  test("a hop the runner is still running is not started a second time on the next tick", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: fixture("ok"), hang: true }));
    const runner = createRunner({ ...w.mkDeps(), instance: "inst-A" });
    await w.screenStart();
    await runner.tick();
    await runner.tick();
    await runner.tick();
    expect(w.spawned).toHaveLength(1);
    w.children[0]!.release();
    await runner.idle();
    expect((await w.hops())[0]!.outcome).toBe("failed"); // the fake wrote nothing to the store
  });

  test("two runners, one hop: the claim is first-come — exactly one runs it, the other skips without error", async () => {
    const w = await world();
    const a = createRunner({ ...w.mkDeps(), instance: "inst-A" });
    const b = createRunner({ ...w.mkDeps(), instance: "inst-B" });
    await w.screenStart();
    await Promise.all([a.tick(), b.tick()]);
    await Promise.all([a.idle(), b.idle()]);
    expect(w.spawned).toHaveLength(1);
    expect(await w.hops()).toHaveLength(1);
  });

  test("a running hop claimed by ANOTHER instance (a dead runner) → interrupted, and a new hop on the same card and worker is claimed and run", async () => {
    const w = await world();
    const orphan = await w.api.startHop(w.project.id, { cardId: w.card.id, workerId: w.worker.id, claim: "dead-inst" });
    const runner = createRunner({ ...w.mkDeps(), instance: "inst-B" });
    await runner.tick();
    await runner.idle();
    const rows = await w.hops(); // newest first
    expect(rows).toHaveLength(2);
    const [fresh, old] = rows;
    expect([old!.id, old!.outcome, old!.claimedBy, old!.note]).toEqual([orphan.id, "interrupted", "dead-inst", "ถูกขัดจังหวะเพราะตัวรันเริ่มใหม่"]); // the PM's word (REQ-012)
    expect([fresh!.cardId, fresh!.workerId, fresh!.claimedBy, fresh!.outcome]).toEqual([w.card.id, w.worker.id, "inst-B", "commented"]);
    expect(w.spawned).toHaveLength(1); // the orphan was never "run" again — it was ended, and a new hop ran
  });

  test("an API error in one project is logged and does not stop the tick (nothing is swallowed, nothing crashes the loop)", async () => {
    const w = await world();
    const deps = w.mkDeps();
    const real = deps.api.hops;
    deps.api = { ...deps.api, hops: async () => { throw new Error("boom"); } };
    const runner = createRunner({ ...deps, instance: "inst-A" });
    await runner.tick();
    expect(w.log.join("\n")).toContain("boom");
    void real;
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
describe("tick — automatic mode (TASK-C-031)", () => {
  /** n cards assigned to the worker (#1 is world()'s), the project switched to dispatcher with `hopBudget`, and a fake worker whose turn is
   *  what a real one does: move the card to review and comment. `how[cardId]` overrides it for one card. */
  async function auto(n = 3, hopBudget = 10) {
    const w = await world();
    const cards = [w.card];
    for (let i = 2; i <= n; i++) cards.push((await newCard(w.call, w.project.id, { title: `card ${i}`, assigneeId: w.worker.id })).json);
    const sw = await w.call("PATCH", `/v1/projects/${w.project.id}/mode`, { mode: "dispatcher", hopBudget });
    if (sw.status !== 200) throw new Error(JSON.stringify(sw.json));
    const cardOf = (cmd: string[]) => /Your card is (\S+)/.exec(cmd[2]!)![1]!;
    const turn = async (cardId: string) => { // status first, comment LAST: the last write decides the outcome (`commented`)
      await w.call("PATCH", `/v1/cards/${cardId}/status`, { status: "review" }, w.actor);
      await w.call("POST", `/v1/cards/${cardId}/comments`, { text: "done" }, w.actor);
    };
    const how: Record<string, (cardId: string) => Promise<void>> = {};
    w.set((cmd) => { const id = cardOf(cmd); return fakeChild({ lines: fixture("ok"), before: () => (how[id] ?? turn)(id) }); });
    const runner = (instance = "inst-A", extra: Partial<HopDeps> = {}) => createRunner({ ...w.mkDeps(), ...extra, instance });
    /** ticks until a tick starts nothing new (every hop it started has finished) — at most `max` */
    const drive = async (r: ReturnType<typeof runner>, max = 12) => { for (let i = 0; i < max; i++) { await r.tick(); await r.idle(); } };
    const runs = () => w.api.runs(w.project.id);
    const hopsOldestFirst = async () => (await w.hops()).reverse();
    return { ...w, cards, how, runner, drive, runs, hopsOldestFirst, turn };
  }

  test("no open run: one quiet tick (the screen may be about to open it), then the runner opens one with the project's hopBudget and takes the lowest card", async () => {
    const a = await auto(3, 10);
    const r = a.runner();
    await r.tick();
    expect(await a.runs()).toHaveLength(0);
    await r.tick();
    await r.idle();
    const [run] = await a.runs();
    expect([run!.hopBudget, run!.endedAt]).toEqual([10, null]);
    const [h] = await a.hops();
    expect([h!.cardId, h!.runId, h!.claimedBy, h!.outcome]).toEqual([a.cards[0]!.id, run!.id, "inst-A", "commented"]);
    const started = (await a.api.events(a.project.id, 0, 500)).find((e) => e.type === "run.started")!;
    expect(started.actor).toBe("runner:test"); // contract v1.2: the runner's writes are the runner's
  });

  test("AC-2: 5 workable cards, budget 3 → exactly 3 hops (cards 1, 2, 3), then the run is budget_spent", async () => {
    const a = await auto(5, 3);
    await a.drive(a.runner());
    const hops = await a.hopsOldestFirst();
    expect(hops.map((h) => h.cardId)).toEqual(a.cards.slice(0, 3).map((c) => c.id));
    expect(hops.every((h) => h.outcome === "commented")).toBe(true);
    const runs = await a.runs();
    expect(runs).toHaveLength(1);
    expect([runs[0]!.stopReason, runs[0]!.hopsUsed]).toEqual(["budget_spent", 3]);
    expect(runs[0]!.report).toContain("- เหตุที่จบรอบ: ใช้งบครบแล้ว"); // the full report (TASK-C-032), the reason in REQ-012's words
    expect(runs[0]!.report).toContain("- 3 ก้าว จากงบ 3");
  });

  test("the PROJECT's budget can refuse a hop the run's budget would allow (409 no_budget) → the run ends budget_spent", async () => {
    const a = await auto(3, 2);
    // one hop is already used outside this run (project hopsUsed 1 of 2) — started by hand, as the screen would, while still in manual
    await a.call("PATCH", `/v1/projects/${a.project.id}/mode`, { mode: "manual" });
    const first = (await a.call("POST", `/v1/projects/${a.project.id}/hops`, { cardId: a.cards[2]!.id, workerId: a.worker.id }, "operator")).json;
    await a.api.finishHop(first.id, { outcome: "commented" });
    await a.call("PATCH", `/v1/projects/${a.project.id}/mode`, { mode: "dispatcher" }); // budget stays 2, hopsUsed is 1
    await a.drive(a.runner());
    const runs = await a.runs();
    expect(runs[0]!.stopReason).toBe("budget_spent");
    expect((await a.hops()).filter((h) => h.runId === runs[0]!.id)).toHaveLength(1); // only ONE more hop was allowed
  });

  test("nothing workable ends the run (once) — later ticks do not open another one", async () => {
    const a = await auto(2, 10);
    const r = a.runner();
    await a.drive(r, 10);
    const runs = await a.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.stopReason).toBe("nothing_workable");
    expect(runs[0]!.report).toContain("- เหตุที่จบรอบ: ไม่มีงานที่ทำต่อได้");
    await a.drive(r, 5);
    expect(await a.runs()).toHaveLength(1); // no run-per-tick loop
  });

  test("the operator switches again after a run ended → a new run opens (and only then)", async () => {
    const a = await auto(1, 10);
    const r = a.runner();
    await a.drive(r, 8);
    expect(await a.runs()).toHaveLength(1);
    await newCard(a.call, a.project.id, { title: "later", assigneeId: a.worker.id });
    await a.call("PATCH", `/v1/projects/${a.project.id}/mode`, { mode: "manual" });
    await a.drive(r, 2);
    await a.call("PATCH", `/v1/projects/${a.project.id}/mode`, { mode: "dispatcher", hopBudget: 10 });
    await a.drive(r, 6);
    const runs = await a.runs();
    expect(runs).toHaveLength(2);
    expect(runs[0]!.stopReason).toBe("nothing_workable"); // the new run took the new card, then ended
    expect((await a.hops()).filter((h) => h.runId === runs[0]!.id)).toHaveLength(1);
  });

  test("one hop at a time: while one runs, further ticks start no other", async () => {
    const a = await auto(3, 10);
    a.set(() => fakeChild({ lines: fixture("ok"), hang: true }));
    const r = a.runner();
    for (let i = 0; i < 5; i++) await r.tick();
    expect(a.spawned).toHaveLength(1);
    a.children[0]!.release();
    await r.idle();
  });

  test("AC-3: switching to manual mid-hop — the hop finishes `commented`, no new hop starts, the run ends operator_stopped; switching back resumes from the store", async () => {
    const a = await auto(3, 10);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    a.how[a.cards[0]!.id] = async (id) => { await gate; await a.turn(id); };
    const r = a.runner();
    await r.tick(); await r.tick();            // opens the run, starts hop 1 (it waits on the gate)
    const before = { cards: (await a.api.card(a.cards[1]!.id)).status, runs: (await a.runs()).length };
    await a.call("PATCH", `/v1/projects/${a.project.id}/mode`, { mode: "manual" });
    await r.tick();
    let [run] = await a.runs();
    expect(run!.stopReason).toBe("operator_stopped");
    expect(run!.report).toContain("- เหตุที่จบรอบ: คุณสั่งหยุด");
    expect((await a.hops())[0]!.endedAt).toBeNull();                       // the hop in progress is NOT killed
    release();
    await r.idle();
    expect((await a.hops())[0]!.outcome).toBe("commented");                // it finished normally
    for (let i = 0; i < 3; i++) await r.tick();
    expect(await a.hops()).toHaveLength(1);                                // no hop 2 within 3 ticks
    expect((await a.api.card(a.cards[1]!.id)).status).toBe(before.cards);  // card 2 untouched
    await a.call("PATCH", `/v1/projects/${a.project.id}/mode`, { mode: "dispatcher" });
    await a.drive(r, 4);
    const hops = await a.hopsOldestFirst();
    expect(hops[1]!.cardId).toBe(a.cards[1]!.id);                          // the next workable card — card 1 is in review
    expect(new Set(hops.map((h) => h.runId)).size).toBe(2);                // a new run
    expect(before.runs).toBe(1);
    void run;
  });

  test("AC-4 under automatic mode: the runner dies mid-hop, a new one takes over — old hop interrupted, the SAME run and card go on, every card hopped exactly once", async () => {
    const a = await auto(4, 10);
    const alive = { stop: false };
    let hold!: () => void;
    const gate = new Promise<void>((res) => { hold = res; });
    a.how[a.cards[0]!.id] = async () => { await gate; };                    // card 1's worker never gets as far as writing
    const dying = a.runner("inst-A", { stopping: () => alive.stop });
    await dying.tick(); await dying.tick();                                  // run opened, hop 1 started, claimed by inst-A
    while (a.children.length === 0) await new Promise((r) => setTimeout(r, 5)); // ...and claude spawned (the start is asynchronous)
    const [h1] = await a.hops();
    expect(h1!.claimedBy).toBe("inst-A");
    alive.stop = true; a.children[0]!.kill();                                // "the runner is stopped": its child dies with it, the hop is left running
    await dying.idle();
    a.how[a.cards[0]!.id] = a.turn;                                         // the new runner's worker does its turn
    const next = a.runner("inst-B");
    await a.drive(next, 12);
    hold();
    const hops = await a.hopsOldestFirst();
    expect(hops.map((h) => [h.cardId === a.cards[0]!.id ? 1 : a.cards.findIndex((c) => c.id === h.cardId) + 1, h.outcome])).toEqual([[1, "interrupted"], [1, "commented"], [2, "commented"], [3, "commented"], [4, "commented"]]);
    expect(new Set(hops.map((h) => h.runId)).size).toBe(1);                 // one run throughout
    expect(hops[1]!.claimedBy).toBe("inst-B");
    expect((await a.runs())[0]!.stopReason).toBe("nothing_workable");
  });

  test("AC-5: a worker asks the operator → its card and the card that depends on it wait; an independent card is hopped next", async () => {
    const w = await world();
    const mk = (title: string, over: object = {}) => newCard(w.call, w.project.id, { title, assigneeId: w.worker.id, ...over }).then((r) => r.json);
    const A = w.card;
    const B = await mk("B depends on A", { dependsOn: [A.id] });
    const C = await mk("C independent");
    await w.call("PATCH", `/v1/projects/${w.project.id}/mode`, { mode: "dispatcher", hopBudget: 10 });
    const order: string[] = [];
    w.set((cmd) => {
      const id = /Your card is (\S+)/.exec(cmd[2]!)![1]!;
      order.push(id === A.id ? "A" : id === B.id ? "B" : "C");
      return fakeChild({ lines: fixture("ok"), before: async () => {
        if (id === A.id) await w.call("POST", `/v1/cards/${A.id}/question`, { text: "which?", proposedDefault: "x", cases: ["a"] }, w.actor);
        else { await w.call("PATCH", `/v1/cards/${id}/status`, { status: "review" }, w.actor); await w.call("POST", `/v1/cards/${id}/comments`, { text: "done" }, w.actor); }
      } });
    });
    const r = createRunner({ ...w.mkDeps(), instance: "inst-A" });
    await r.tick(); await r.tick(); await r.idle();                          // hop 1: A asks
    const workableNow = (await w.call("GET", `/v1/projects/${w.project.id}/cards?workable=true`)).json.cards.map((c: any) => c.title);
    expect(workableNow).toEqual(["C independent"]);                          // A and B wait
    for (let i = 0; i < 8; i++) { await r.tick(); await r.idle(); }
    expect(order).toEqual(["A", "C"]);                                       // B never runs
    expect((await w.hops()).reverse().map((h) => h.outcome)).toEqual(["asked", "commented"]);
    expect((await w.api.runs(w.project.id))[0]!.stopReason).toBe("nothing_workable");
  });

  test("a card whose hop FAILED is not hopped again in the same run — the run goes on with the next card", async () => {
    const a = await auto(3, 10);
    a.how[a.cards[0]!.id] = async () => {};                                  // card 1's worker writes nothing → failed
    await a.drive(a.runner());
    const hops = await a.hopsOldestFirst();
    expect(hops.map((h) => [a.cards.findIndex((c) => c.id === h.cardId) + 1, h.outcome])).toEqual([[1, "failed"], [2, "commented"], [3, "commented"]]);
  });

  test("a card with no assignee is left alone", async () => {
    const a = await auto(2, 10);
    const loose = (await newCard(a.call, a.project.id, { title: "nobody's" })).json;
    await a.drive(a.runner());
    expect((await a.hops()).some((h) => h.cardId === loose.id)).toBe(false);
  });

  test("a card the API refuses a hop for (400 not_a_member: its assignee is not in the chain) is logged ONCE by name; the run goes on without it", async () => {
    const a = await auto(3, 10);
    const deps = a.mkDeps();
    const real = deps.api.startHop;
    deps.api = { ...deps.api, startHop: async (p, input) => {
      if (input.cardId === a.cards[0]!.id) throw new RunnerApiError(400, "not_a_member", "worker is not in this project's chain");
      return real(p, input);
    } };
    await a.drive(createRunner({ ...deps, instance: "inst-A" }), 10);
    const hops = await a.hopsOldestFirst();
    expect(hops.map((h) => h.cardId)).toEqual([a.cards[1]!.id, a.cards[2]!.id]); // card 1 was skipped, 2 and 3 were still reached
    expect(a.log.filter((l) => l.includes("not_a_member") && l.includes(a.cards[0]!.id))).toHaveLength(1); // once, not once per tick
    expect((await a.runs())[0]!.stopReason).toBe("nothing_workable");
  });

  test("a TRANSIENT API failure on a hop start (network, 5xx, unreadable body) does not ban the card: the tick logs it and the next tick tries again", async () => {
    const a = await auto(1, 10);
    const deps = a.mkDeps();
    const real = deps.api.startHop;
    let calls = 0;
    deps.api = { ...deps.api, startHop: async (p, input) => { if (calls++ === 0) throw new RunnerApiError(0, "network", "ECONNREFUSED"); return real(p, input); } };
    await a.drive(createRunner({ ...deps, instance: "inst-A" }), 8);
    expect((await a.hopsOldestFirst()).map((h) => h.outcome)).toEqual(["commented"]);   // the only card WAS worked
    expect((await a.runs())[0]!.stopReason).toBe("nothing_workable");                      // ...and only then did the run end
    expect(a.log.some((l) => l.includes("ECONNREFUSED"))).toBe(true);
  });

  test("a hop of ours that ended between the listing and the check still counts toward its card's turn — no second hop on it in the same run", async () => {
    const a = await auto(2, 10);
    const r0 = await a.call("POST", `/v1/projects/${a.project.id}/runs`, { hopBudget: 10 }, "operator");
    const hop = await a.api.startHop(a.project.id, { cardId: a.cards[0]!.id, workerId: a.worker.id, runId: r0.json.id, claim: "inst-A" }); // ours, but not being run
    await a.api.finishHop(hop.id, { outcome: "commented" });                                   // it ended — the card is still `todo`, i.e. workable
    const deps = a.mkDeps();
    let n = 0;
    deps.api = { ...deps.api, hops: async (p, limit) => { const real = await a.api.hops(p, limit); return n++ === 0 ? real.map((h) => ({ ...h, endedAt: null, outcome: null })) : real; } };
    const r = createRunner({ ...deps, instance: "inst-A" });
    await r.tick(); await r.idle();
    const hops = await a.hopsOldestFirst();
    expect(hops.filter((h) => h.cardId === a.cards[0]!.id)).toHaveLength(1);   // card 1 was not hopped a second time
    expect(hops.map((h) => h.cardId)).toEqual([a.cards[0]!.id, a.cards[1]!.id]); // card 2 got the turn
  });

  test("R6: the subscription limit — the hop is stopped with the Thai reset time, the run ends limit_reached (with its report), and no run reopens by itself", async () => {
    const a = await auto(3, 10);
    const now = new Date("2026-10-13T10:00:00Z");
    a.set((cmd) => /Your card is (\S+)/.exec(cmd[2]!)![1] === a.cards[0]!.id
      ? fakeChild({ lines: limitFixture().slice(0, 14), hang: true })
      : fakeChild({ lines: fixture("ok") }));
    const r = a.runner("inst-A", { now: () => now });
    await a.drive(r, 10);
    const hops = await a.hopsOldestFirst();
    expect(hops).toHaveLength(1);                                           // nothing after the limit
    expect([hops[0]!.outcome, hops[0]!.note]).toEqual(["stopped", `ถึงลิมิตการใช้งาน Claude — จะทำต่อได้หลัง ${formatReset(1791898200, now)}`]);
    const runs = await a.runs();
    expect(runs).toHaveLength(1);                                           // and no new run opened by itself
    expect(runs[0]!.stopReason).toBe("limit_reached");
    expect(runs[0]!.report).toContain(`- เหตุที่จบรอบ: ถึงลิมิตการใช้งาน Claude — จะทำต่อได้หลัง ${formatReset(1791898200, now)}`);
    expect(runs[0]!.report).toContain("หยุดไว้: ถึงลิมิตการใช้งาน Claude");     // the stopped hop is a problem too
  });

  test("R6: a card sent back from review twice ends the run failed_review_twice, in REQ-012's words", async () => {
    const a = await auto(3, 10);
    const r = a.runner();
    await r.tick(); await r.tick(); await r.idle();                        // run open, hop 1 done: card 1 is in review
    const op = (status: string) => a.call("PATCH", `/v1/cards/${a.cards[0]!.id}/status`, { status }, "operator");
    await op("todo"); await op("review"); await op("todo");                // the reviewer sends it back — twice
    await r.tick();
    const [run] = await a.runs();
    expect(run!.stopReason).toBe("failed_review_twice");
    expect(run!.report).toContain("- เหตุที่จบรอบ: การ์ดนี้ไม่ผ่านตรวจสองครั้ง");
    expect(await a.hops()).toHaveLength(1);                                 // no hop after it
  });

  test("AC-7: after a run of 3 hops (commented, asked, stopped) the stored report matches the hops and cards line by line", async () => {
    const w = await world();
    const mk = (title: string) => newCard(w.call, w.project.id, { title, assigneeId: w.worker.id }).then((r) => r.json);
    const A = w.card, B = await mk("B asks"), C = await mk("C is blocked");
    await w.call("PATCH", `/v1/projects/${w.project.id}/mode`, { mode: "dispatcher", hopBudget: 10 });
    const blockLines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git push origin HEAD" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "PreToolUse:Bash hook error: [/x/block-irreversible.sh]: Blocked (git push)" }] } }),
    ];
    w.set((cmd) => {
      const id = /Your card is (\S+)/.exec(cmd[2]!)![1]!;
      if (id === C.id) return fakeChild({ lines: blockLines, hang: true });
      return fakeChild({ lines: fixture("ok"), before: async () => {
        if (id === B.id) await w.call("POST", `/v1/cards/${B.id}/question`, { text: "ใช้สีไหน?", proposedDefault: "น้ำเงิน", cases: ["a"] }, w.actor);
        else { await w.call("PATCH", `/v1/cards/${id}/status`, { status: "done" }, w.actor); await w.call("POST", `/v1/cards/${id}/comments`, { text: "ok" }, w.actor); }
      } });
    });
    const r = createRunner({ ...w.mkDeps(), instance: "inst-A" });
    for (let i = 0; i < 10; i++) { await r.tick(); await r.idle(); }
    const run = (await w.api.runs(w.project.id))[0]!;
    const hops = (await w.api.hops(w.project.id)).reverse();
    expect(hops.map((h) => h.outcome)).toEqual(["commented", "asked", "stopped"]);
    const cards = await w.api.cards(w.project.id);
    const text = run.report!;
    const lines = text.split("\n");
    const part = (name: string, next: string) => lines.slice(lines.indexOf(name) + 1, lines.indexOf(next));
    expect(part("เสร็จแล้ว", "ทีมตัดสินเอง")).toEqual([`- #${A.number} ${A.title}`]);                    // the one card that is done
    expect(part("รอคุณ", "ปัญหา")).toEqual([`- #${cards.find((c) => c.kind === "question")!.number} ใช้สีไหน?`]); // the waiting question
    expect(part("ปัญหา", "ค่าใช้จ่าย")).toEqual([
      `- ก้าว 3 (#${C.number}) ${hops[2]!.note}`, // the stored note already starts with หยุดไว้                                                      // the problem hop, with its stored note
      "- เหตุที่จบรอบ: ไม่มีงานที่ทำต่อได้",
    ]);
    const sum = (k: "tokensIn" | "tokensOut") => hops.reduce((s, h) => s + (h[k] ?? 0), 0).toLocaleString("en-US");
    const cost = lines.slice(lines.indexOf("ค่าใช้จ่าย") + 1);
    expect(cost.slice(0, 2)).toEqual(["- 3 ก้าว จากงบ 10", `- โทเค็นเข้า ${sum("tokensIn")} ออก ${sum("tokensOut")}`]);
    expect(cost[2]).toMatch(/^- ใช้เวลา /);
    expect(run.hopsUsed).toBe(3);
  });

  test("a report that cannot be built does not leave the run open: it ends with the reason alone, and the failure is logged", async () => {
    const a = await auto(1, 10);
    const deps = a.mkDeps();
    deps.api = { ...deps.api, cards: async () => { throw new RunnerApiError(500, "unknown", "boom"); } };
    await a.drive(createRunner({ ...deps, instance: "inst-A" }), 8);
    const [run] = await a.runs();
    expect([run!.stopReason, run!.report]).toEqual(["nothing_workable", "ไม่มีงานที่ทำต่อได้"]);
    expect(a.log.some((l) => l.includes("report") && l.includes("boom"))).toBe(true);
  });

  test("a limit whose run could not be closed (API failed) is closed on the next tick — no new hop first; this survives a restart because it is read from the store", async () => {
    const a = await auto(3, 10);
    const now = new Date("2026-10-13T10:00:00Z");
    a.set((cmd) => /Your card is (\S+)/.exec(cmd[2]!)![1] === a.cards[0]!.id ? fakeChild({ lines: limitFixture().slice(0, 14), hang: true }) : fakeChild({ lines: fixture("ok") }));
    const deps = a.mkDeps();
    let failures = 1;
    deps.api = { ...deps.api, finishRun: async (id, input) => { if (failures-- > 0) throw new RunnerApiError(503, "unknown", "api down"); return a.api.finishRun(id, input); } };
    const first = createRunner({ ...deps, instance: "inst-A", now: () => now });
    await first.tick(); await first.tick(); await first.idle();                // the hop hits the limit; closing the run fails
    expect((await a.runs())[0]!.endedAt).toBeNull();
    expect(a.log.some((l) => l.includes("api down"))).toBe(true);
    const second = createRunner({ ...a.mkDeps(), instance: "inst-B", now: () => now }); // a NEW runner: nothing in memory
    await second.tick(); await second.idle();
    const [run] = await a.runs();
    expect(run!.stopReason).toBe("limit_reached");
    expect(await a.hops()).toHaveLength(1);                                       // and no second hop was started
  });

  test("a run the screen already opened (409 run_open), or already finished (409 already_finished), is not an error", async () => {
    const a = await auto(1, 10);
    const deps = a.mkDeps();
    deps.api = { ...deps.api,
      startRun: async () => { throw new RunnerApiError(409, "run_open", "this project already has an open run"); },
      finishRun: async () => { throw new RunnerApiError(409, "already_finished", "that run has already finished"); },
    };
    const r = createRunner({ ...deps, instance: "inst-A" });
    await r.tick(); await r.tick();
    expect(a.log.filter((l) => /run_open|already_finished/.test(l))).toEqual([]);
  });

  test("an interrupted hop of a FINISHED run is restarted without that run (the API would refuse it), and a runner fault is stored in the PM's words", async () => {
    const a = await auto(1, 10);
    const run = (await a.call("POST", `/v1/projects/${a.project.id}/runs`, { hopBudget: 5 }, "operator")).json;
    const stale = await a.api.startHop(a.project.id, { cardId: a.cards[0]!.id, workerId: a.worker.id, claim: "dead-inst", runId: run.id });
    expect(stale.runId).toBe(run.id);
    await a.call("PATCH", `/v1/runs/${run.id}`, { stopReason: "operator_stopped", report: "x" }, "operator"); // the run ended while the runner was down
    await a.call("PATCH", `/v1/projects/${a.project.id}/mode`, { mode: "manual" });
    a.set(() => { throw new Error("ENOENT claude"); });
    const r = a.runner("inst-B");
    await r.tick(); await r.idle();
    const rows = await a.hopsOldestFirst();
    expect(rows.map((h) => [h.outcome, h.runId])).toEqual([["interrupted", run.id], ["failed", null]]);
    expect(rows[1]!.note).toBe("ตัวรันขัดข้อง: ENOENT claude");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
describe("the leftover of a hard-killed runner (TASK-C-035, DEF-1)", () => {
  const LSTART = "Tue Oct 14 01:00:00 2026";
  const fileFor = (w: any, hop: { id: string }, over: Partial<HopFile> = {}): HopFile => ({
    hopId: hop.id, projectId: w.project.id, apiUrl: "http://127.0.0.1:4530", pid: 7001, pgid: 7001, instance: "dead-inst", claudeBin: "/bin/claude", startedAt: "t", lstart: LSTART, runnerPid: 5, runnerLstart: "gone", ...over,
  });
  /** a process table with one live group; `order` records every kill and every `interrupted` write, in sequence */
  function leftoverWorld(w: any, table: Record<number, { lstart: string; pgid: number }>, opts: { stuck?: boolean } = {}) {
    const order: string[] = [];
    const procs: Procs = {
      inspect: (pid) => (table[pid] ? { ...table[pid]!, command: "claude" } : null),
      groupAlive: (pgid) => Object.values(table).some((p) => p.pgid === pgid),
      killGroup: (pgid, sig) => { order.push(`kill ${sig} -${pgid}`); if (!opts.stuck) for (const [pid, p] of Object.entries(table)) if (p.pgid === pgid) delete table[Number(pid)]; },
      sleep: async () => {},
    };
    const deps = w.mkDeps();
    deps.procs = procs;
    deps.killGraceMs = 10;
    const realFinish = deps.api.finishHop;
    deps.api = { ...deps.api, finishHop: async (id: string, f: any) => { if (f.outcome === "interrupted") order.push("interrupted written"); return realFinish(id, f); } };
    return { deps, order, procs };
  }

  test("the leftover group is stopped BEFORE the hop is marked interrupted and the card is handed to a new worker", async () => {
    const w = await world();
    const orphan = await w.api.startHop(w.project.id, { cardId: w.card.id, workerId: w.worker.id, claim: "dead-inst" });
    writeHopFile(w.hopsDir, fileFor(w, orphan));
    const { deps, order } = leftoverWorld(w, { 7001: { lstart: LSTART, pgid: 7001 } });
    const r = createRunner({ ...deps, instance: "inst-B" });
    await r.tick(); await r.idle();
    expect(order).toEqual(["kill SIGTERM -7001", "interrupted written"]);                // the ORDER is the fix
    const rows = (await w.hops()).reverse();
    expect(rows.map((h) => h.outcome)).toEqual(["interrupted", "commented"]);             // then the card is redone, once
    expect(readHopFile(w.hopsDir, orphan.id, () => {})).toBeNull();                       // and the dead hop\'s file is cleaned up
  });

  test("a RECYCLED pid (another process now) is never killed — the hop is still interrupted and redone, as before", async () => {
    const w = await world();
    const orphan = await w.api.startHop(w.project.id, { cardId: w.card.id, workerId: w.worker.id, claim: "dead-inst" });
    writeHopFile(w.hopsDir, fileFor(w, orphan));
    const { deps, order } = leftoverWorld(w, { 7001: { lstart: "Wed Oct 15 09:30:00 2026", pgid: 7001 } });
    await createRunner({ ...deps, instance: "inst-B" }).tick();
    expect(order).toEqual(["interrupted written"]);                                       // no kill at all
    expect(w.log.some((l) => l.includes("NOT touching"))).toBe(true);                     // and it says why
  });

  test("a group that cannot be stopped keeps the hop RUNNING: no interrupted, no second worker on the card; the next tick tries again", async () => {
    const w = await world();
    const orphan = await w.api.startHop(w.project.id, { cardId: w.card.id, workerId: w.worker.id, claim: "dead-inst" });
    writeHopFile(w.hopsDir, fileFor(w, orphan));
    const table: Record<number, { lstart: string; pgid: number }> = { 7001: { lstart: LSTART, pgid: 7001 } };
    const stuck = leftoverWorld(w, table, { stuck: true });
    const r = createRunner({ ...stuck.deps, instance: "inst-B" });
    await r.tick(); await r.tick(); await r.idle();
    expect((await w.hops()).map((h) => h.outcome)).toEqual([null]);                       // still the one running hop; nothing new
    expect(w.spawned).toHaveLength(0);
    expect(stuck.order.filter((o) => o === "interrupted written")).toEqual([]);
    expect(w.log.some((l) => l.includes("STILL alive"))).toBe(true);
    delete table[7001];                                                                   // the group finally dies
    await r.tick(); await r.idle();
    expect(((await w.hops()).reverse()).map((h) => h.outcome)).toEqual(["interrupted", "commented"]);
  });

  test("the runner that started the hop is STILL ALIVE (a second runner on the same API): its hop is not an orphan — not interrupted, its worker not killed, no second worker", async () => {
    const w = await world();
    const live = await w.api.startHop(w.project.id, { cardId: w.card.id, workerId: w.worker.id, claim: "other-inst" });
    writeHopFile(w.hopsDir, fileFor(w, live, { runnerPid: 5, runnerLstart: "L5" }));
    const { deps, order } = leftoverWorld(w, { 7001: { lstart: LSTART, pgid: 7001 }, 5: { lstart: "L5", pgid: 5 } });
    const r = createRunner({ ...deps, instance: "inst-B" });
    await r.tick(); await r.tick(); await r.idle();
    expect(order).toEqual([]);                                                            // nothing killed, nothing interrupted
    expect((await w.hops()).map((h) => h.outcome)).toEqual([null]);
    expect(w.spawned).toHaveLength(0);
    expect(readHopFile(w.hopsDir, live.id, () => {})).not.toBeNull();                     // its file stays
    expect(w.log.some((l) => l.includes("still running — leaving it alone"))).toBe(true);
  });

  test("sweepStray at start: a file whose hop FINISHED in the store → its leftover is stopped and the file deleted", async () => {
    const w = await world();
    const done = await w.api.startHop(w.project.id, { cardId: w.card.id, workerId: w.worker.id, claim: "dead-inst" });
    await w.api.finishHop(done.id, { outcome: "failed" });
    writeHopFile(w.hopsDir, fileFor(w, done));
    const { deps, order } = leftoverWorld(w, { 7001: { lstart: LSTART, pgid: 7001 } });
    await createRunner({ ...deps, instance: "inst-B" }).sweepStray();
    expect(order).toEqual(["kill SIGTERM -7001"]);
    expect(readHopFile(w.hopsDir, done.id, () => {})).toBeNull();
  });

  test("sweepStray leaves alone: a hop still running in the store (the orphan rule handles it when it is seen), and another API\'s files", async () => {
    const w = await world();
    const running = await w.api.startHop(w.project.id, { cardId: w.card.id, workerId: w.worker.id, claim: "dead-inst" });
    writeHopFile(w.hopsDir, fileFor(w, running));
    writeHopFile(w.hopsDir, fileFor(w, { id: "elsewhere" }, { apiUrl: "http://127.0.0.1:4500", pid: 7002, pgid: 7002 }));
    const { deps, order } = leftoverWorld(w, { 7001: { lstart: LSTART, pgid: 7001 }, 7002: { lstart: LSTART, pgid: 7002 } });
    await createRunner({ ...deps, instance: "inst-B" }).sweepStray();
    expect(order).toEqual([]);
    expect(readHopFile(w.hopsDir, running.id, () => {})).not.toBeNull();
    expect(readHopFile(w.hopsDir, "elsewhere", () => {})).not.toBeNull();
  });

  test("sweepStray: a file whose hop the store does not know (reset database) is stopped and deleted too", async () => {
    const w = await world();
    writeHopFile(w.hopsDir, fileFor(w, { id: "ghost" }));
    const { deps, order } = leftoverWorld(w, { 7001: { lstart: LSTART, pgid: 7001 } });
    await createRunner({ ...deps, instance: "inst-B" }).sweepStray();
    expect(order).toEqual(["kill SIGTERM -7001"]);
    expect(readHopFile(w.hopsDir, "ghost", () => {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
describe("chat hops: the entry worker answers an operator message (TASK-C-034)", () => {
  async function chat(opts: { entry?: boolean } = {}) {
    const w = await world();
    if (opts.entry !== false) await w.call("PUT", `/v1/projects/${w.project.id}/chain/entry`, { workerId: w.worker.id });
    const say = async (text = "แก้ขั้นอนุมัติห้องใหญ่") => (await w.call("POST", `/v1/projects/${w.project.id}/chat`, { text })).json;
    const runningHopOn = async (messageId: string) => (await w.api.hops(w.project.id)).find((h) => h.messageId === messageId && h.endedAt === null)!;
    const answer = async (messageId: string) => w.call("POST", `/v1/chat/${messageId}/reply`, { text: "รับทราบ" }, w.actor, { "x-caw-hop": (await runningHopOn(messageId)).id });
    const messageOf = (cmd: string[]) => /message (\S+) in project/.exec(cmd[2]!)![1]!;
    const isChat = (cmd: string[]) => cmd[2]!.includes("chat_context");
    const chatHops = async () => (await w.hops()).filter((h) => h.messageId !== null).reverse();
    /** chat hops reply; card hops do their turn; `hang` messages never end */
    const setBehaviour = (over: { chat?: (cmd: string[]) => FakeChild } = {}) => w.set((cmd) => isChat(cmd)
      ? (over.chat ? over.chat(cmd) : fakeChild({ lines: fixture("ok"), before: async () => { await answer(messageOf(cmd)); } }))
      : fakeChild({ lines: fixture("ok"), before: async () => {
          const id = /Your card is (\S+)/.exec(cmd[2]!)![1]!;
          await w.call("PATCH", `/v1/cards/${id}/status`, { status: "review" }, w.actor);
          await w.call("POST", `/v1/cards/${id}/comments`, { text: "done" }, w.actor);
        } }));
    setBehaviour();
    return { ...w, say, answer, messageOf, chatHops, setBehaviour, runningHopOn };
  }

  test("MANUAL mode: a message is the go — one chat hop for the entry worker, answered, with no run and no card", async () => {
    const c = await chat();
    const m = await c.say();
    const r = createRunner({ ...c.mkDeps(), instance: "inst-A" });
    await r.tick(); await r.idle();
    const [h] = await c.chatHops();
    expect([h!.messageId, h!.cardId, h!.runId, h!.workerId, h!.claimedBy, h!.outcome]).toEqual([m.id, null, null, c.worker.id, "inst-A", "replied"]);
    expect((await c.api.chatMessages(c.project.id)).find((x) => x.id === m.id)!.replyHopId).toBe(h!.id);
    expect(c.spawned).toHaveLength(1);
  });

  test("an answered message gets no second hop, however many ticks pass", async () => {
    const c = await chat();
    await c.say();
    const r = createRunner({ ...c.mkDeps(), instance: "inst-A" });
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    expect(c.spawned).toHaveLength(1);
  });

  test("dispatcher with an open run and a workable card: the chat message goes FIRST, outside the run", async () => {
    const c = await chat();
    await c.call("PATCH", `/v1/projects/${c.project.id}/mode`, { mode: "dispatcher", hopBudget: 10 });
    const m = await c.say();
    const r = createRunner({ ...c.mkDeps(), instance: "inst-A" });
    await r.tick(); await r.tick(); await r.idle();
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    const hops = (await c.hops()).reverse();
    expect(hops.map((h) => (h.messageId ? "chat" : "card"))).toEqual(["chat", "card"]);
    expect([hops[0]!.messageId, hops[0]!.runId]).toEqual([m.id, null]);             // no run, no run budget
    expect(hops[1]!.runId).not.toBeNull();                                          // the card hop is in the run
  });

  test("a message waits for a running CARD hop, and goes as soon as it ends (one hop at a time)", async () => {
    const c = await chat();
    await c.call("PATCH", `/v1/projects/${c.project.id}/mode`, { mode: "dispatcher", hopBudget: 10 });
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    c.set((cmd) => cmd[2]!.includes("chat_context")
      ? fakeChild({ lines: fixture("ok"), before: async () => { await c.answer(c.messageOf(cmd)); } })
      : fakeChild({ lines: fixture("ok"), before: async () => { await gate; const id = /Your card is (\S+)/.exec(cmd[2]!)![1]!; await c.call("POST", `/v1/cards/${id}/comments`, { text: "x" }, c.actor); } }));
    const r = createRunner({ ...c.mkDeps(), instance: "inst-A" });
    await r.tick(); await r.tick();                                                  // the run opens, the card hop starts and waits
    await c.say();
    for (let i = 0; i < 3; i++) await r.tick();
    expect((await c.chatHops())).toHaveLength(0);                                     // the message waits
    release(); await r.idle();
    await r.tick(); await r.idle();
    expect((await c.chatHops()).map((h) => h.outcome)).toEqual(["replied"]);
  });

  test("a card hop waits for a running chat hop the same way", async () => {
    const c = await chat();
    await c.call("PATCH", `/v1/projects/${c.project.id}/mode`, { mode: "dispatcher", hopBudget: 10 });
    const m = await c.say();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    c.setBehaviour({ chat: (cmd) => fakeChild({ lines: fixture("ok"), before: async () => { await gate; await c.answer(c.messageOf(cmd)); } }) });
    const r = createRunner({ ...c.mkDeps(), instance: "inst-A" });
    await r.tick(); await r.tick();
    for (let i = 0; i < 3; i++) await r.tick();
    expect((await c.hops()).filter((h) => h.cardId !== null)).toHaveLength(0);       // no card hop while the chat hop runs
    release(); await r.idle();
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    expect((await c.hops()).filter((h) => h.cardId !== null)).toHaveLength(1);
    void m;
  });

  test("NO entry worker: no hop, and the runner says so ONCE per message", async () => {
    const c = await chat({ entry: false });
    const m = await c.say();
    const r = createRunner({ ...c.mkDeps(), instance: "inst-A" });
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    expect(c.spawned).toHaveLength(0);
    expect(c.log.filter((l) => l.includes(m.id) && l.includes("entry worker"))).toHaveLength(1);
  });

  test("a chat hop that FAILED (no reply) is not retried by the runner; the operator\'s next message gets its own hop", async () => {
    const c = await chat();
    c.setBehaviour({ chat: () => fakeChild({ lines: fixture("ok") }) });               // the worker never replies
    const m1 = await c.say("ข้อความแรก");
    const r = createRunner({ ...c.mkDeps(), instance: "inst-A" });
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    expect((await c.chatHops()).map((h) => [h.messageId, h.outcome])).toEqual([[m1.id, "failed"]]);
    c.setBehaviour();
    const m2 = await c.say("ข้อความสอง");
    for (let i = 0; i < 3; i++) { await r.tick(); await r.idle(); }
    expect((await c.chatHops()).map((h) => [h.messageId, h.outcome])).toEqual([[m1.id, "failed"], [m2.id, "replied"]]);
  });

  test("contract v1.9 (A-082): the operator's retry makes a failed message pending again — once; the runner never retries by itself", async () => {
    const c = await chat();
    c.setBehaviour({ chat: () => fakeChild({ lines: fixture("ok") }) });               // the worker never replies
    const m = await c.say("ข้อความแรก");
    const r = createRunner({ ...c.mkDeps(), instance: "inst-A" });
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    expect((await c.chatHops()).map((h) => [h.messageId, h.outcome])).toEqual([[m.id, "failed"]]);
    // a LATER message moves the cursor on in the old code; the failed one must stay reachable
    c.setBehaviour();
    const m2 = await c.say("ข้อความสอง");
    for (let i = 0; i < 3; i++) { await r.tick(); await r.idle(); }
    expect((await c.chatHops()).map((h) => [h.messageId, h.outcome])).toEqual([[m.id, "failed"], [m2.id, "replied"]]);
    const retry = await c.call("POST", `/v1/chat/${m.id}/retry`, {}, "operator");
    expect(retry.status).toBe(202);
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    expect((await c.chatHops()).map((h) => [h.messageId, h.outcome])).toEqual([[m.id, "failed"], [m2.id, "replied"], [m.id, "replied"]]);
    for (let i = 0; i < 3; i++) { await r.tick(); await r.idle(); }
    expect(await c.chatHops()).toHaveLength(3);                                         // answered: no fourth hop
  });

  test("a retry whose new hop fails again waits for the NEXT retry (retryRequestedAt later than the last hop's end)", async () => {
    const c = await chat();
    c.setBehaviour({ chat: () => fakeChild({ lines: fixture("ok") }) });
    const m = await c.say("ข้อความ");
    const r = createRunner({ ...c.mkDeps(), instance: "inst-A" });
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    expect((await c.call("POST", `/v1/chat/${m.id}/retry`, {}, "operator")).status).toBe(202);
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    expect((await c.chatHops()).map((h) => h.outcome)).toEqual(["failed", "failed"]);
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    expect(await c.chatHops()).toHaveLength(2);                                         // never by itself
    expect((await c.call("POST", `/v1/chat/${m.id}/retry`, {}, "operator")).status).toBe(202);
    c.setBehaviour();
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    expect((await c.chatHops()).map((h) => h.outcome)).toEqual(["failed", "failed", "replied"]);
  });

  test("contract v1.8 (D-055, A-081 is in the tree): a chat hop is OUTSIDE the budget — with the dispatcher budget spent it is still answered, while a card hop is refused; the pin from before A-081 flipped here", async () => {
    const c = await chat();
    await c.call("PATCH", `/v1/projects/${c.project.id}/mode`, { mode: "dispatcher", hopBudget: 1 });
    await c.call("POST", `/v1/projects/${c.project.id}/runs`, { hopBudget: 5 }, "operator");
    const hop = await c.api.startHop(c.project.id, { cardId: c.card.id, workerId: c.worker.id });
    await c.api.finishHop(hop.id, { outcome: "commented" });                            // hopsUsed 1 of 1
    const m = await c.say();
    const r = createRunner({ ...c.mkDeps(), instance: "inst-A" });
    await r.tick(); await r.idle();
    expect((await c.chatHops()).map((h) => [h.messageId, h.outcome])).toEqual([[m.id, "replied"]]);
    expect(c.log.some((l) => l.includes("no_budget"))).toBe(false);
  });

  test("an API that still refuses a chat hop for the BUDGET (an older core): logged by name ONCE, the message stays unanswered, and is tried again when the budget is raised", async () => {
    const c = await chat();
    const m = await c.say();
    const deps = c.mkDeps();
    let refuse = true;
    const real = deps.api.startHop;
    deps.api = { ...deps.api, startHop: async (p, input) => { if (refuse && input.messageId) throw new RunnerApiError(409, "no_budget", "the project's hop budget (1) is spent"); return real(p, input); } };
    const r = createRunner({ ...deps, instance: "inst-A" });
    for (let i = 0; i < 4; i++) { await r.tick(); await r.idle(); }
    expect(await c.chatHops()).toEqual([]);
    expect(c.log.filter((l) => l.includes(m.id) && l.includes("no_budget"))).toHaveLength(1);
    refuse = false;                                                                      // the operator raised the budget
    await r.tick(); await r.idle();
    expect((await c.chatHops()).map((h) => h.outcome)).toEqual(["replied"]);
  });

  test("an orphaned CHAT hop (its runner died) is interrupted and restarted ON THE SAME MESSAGE, not on a card", async () => {
    const c = await chat();
    const m = await c.say();
    const orphan = await c.api.startHop(c.project.id, { messageId: m.id, workerId: c.worker.id, claim: "dead-inst" });
    const r = createRunner({ ...c.mkDeps(), instance: "inst-B" });
    await r.tick(); await r.idle();
    const hops = await c.chatHops();
    expect(hops.map((h) => [h.id === orphan.id ? "old" : "new", h.messageId, h.cardId, h.outcome])).toEqual([["old", m.id, null, "interrupted"], ["new", m.id, null, "replied"]]);
  });
});

describe("chat hops — what the agent review found (TASK-C-034)", () => {
  async function chat2() {
    const w = await world();
    await w.call("PUT", `/v1/projects/${w.project.id}/chain/entry`, { workerId: w.worker.id });
    const say = async (text = "ข้อความ") => (await w.call("POST", `/v1/projects/${w.project.id}/chat`, { text })).json;
    return { ...w, say };
  }

  test("an OLD unanswered message whose hop is no longer in the 200 newest hops is not hopped again after a restart (it cannot be known whether it was tried)", async () => {
    const c = await chat2();
    const old = await c.say("ข้อความเก่า");                                           // pretend its failed hop fell out of the window
    const deps = c.mkDeps();
    const real = deps.api.hops;
    // 200 newer hops fill the window (ids sort after the message id); none of them is on the old message
    deps.api = { ...deps.api, hops: async (p, limit) => {
      const filler = Array.from({ length: 200 }, (_, i) => ({ id: `ffffffff-0000-7000-8000-${String(i).padStart(12, "0")}`, projectId: p, runId: null, claimedBy: "x", cardId: c.card.id, messageId: null, workerId: c.worker.id, startedAt: "t", endedAt: "t", outcome: "commented" as const, tokensIn: null, tokensOut: null, note: "" }));
      void real; void limit; return filler;
    } };
    const r = createRunner({ ...deps, instance: "inst-A" });
    for (let i = 0; i < 3; i++) { await r.tick(); await r.idle(); }
    expect(c.spawned).toHaveLength(0);
    expect(c.log.filter((l) => l.includes(old.id) && l.includes("older than the hops"))).toHaveLength(1);   // and it says so, once
  });

  test("with fewer than 200 hops the listing is complete, so an unanswered message with no hop IS answered", async () => {
    const c = await chat2();
    await c.say();
    const r = createRunner({ ...c.mkDeps(), instance: "inst-A" });
    await r.tick(); await r.idle();
    expect(c.spawned).toHaveLength(1);
  });

  test("a refusal that the operator can fix (the entry worker) is not for life: when the entry worker changes, the message is tried again", async () => {
    const c = await chat2();
    const other = (await c.call("POST", "/v1/workers", { name: "Other", role: "BE", skills: ["x"] })).json;
    await c.call("POST", `/v1/projects/${c.project.id}/chain/members`, { workerId: other.id });
    const m = await c.say();
    const deps = c.mkDeps();
    const real = deps.api.startHop;
    deps.api = { ...deps.api, startHop: async (p, input) => { if (input.messageId && input.workerId === c.worker.id) throw new RunnerApiError(400, "not_entry_worker", "only the project's entry worker answers the chat"); return real(p, input); } };
    const r = createRunner({ ...deps, instance: "inst-A" });
    for (let i = 0; i < 3; i++) { await r.tick(); await r.idle(); }
    expect(c.spawned).toHaveLength(0);
    expect(c.log.filter((l) => l.includes(m.id) && l.includes("not_entry_worker"))).toHaveLength(1);   // logged once, not every tick
    await c.call("PUT", `/v1/projects/${c.project.id}/chain/entry`, { workerId: other.id });            // the operator picks another entry worker
    await r.tick(); await r.idle();
    expect((await c.api.hops(c.project.id)).filter((h) => h.messageId === m.id).map((h) => [h.workerId === other.id, h.outcome])).toEqual([[true, "stopped"]]); // it WAS tried with the new entry worker (stopped there: that worker has a skill the workspace does not have)
  });
});

describe("the runner's check-in (TASK-C-040, contract v1.16 rev. 1, REQ-015 R1)", () => {
  /** a fake scheduler: the test fires the timer by hand, so no real second passes */
  function fakeClock() {
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const every = (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; };
    return { every, timers, fire: () => { for (const t of timers) if (t.live) t.fn(); } };
  }
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const mk = (checkIn: (state: "running" | "stopping") => Promise<void>, clock = fakeClock()) => {
    const log: string[] = [];
    return { clock, log, ci: createCheckIn({ api: { checkIn }, log: (l) => log.push(l), every: clock.every }) };
  };

  test("`running` once at the start, then on the 15 s timer: at 15 s and 30 s that is 3 calls — while a long hop is still running", async () => {
    const calls: string[] = [];
    const m = mk(async (s) => { calls.push(s); });
    await m.ci.start();
    expect(calls).toEqual(["running"]);
    expect(m.clock.timers).toHaveLength(1);
    expect(m.clock.timers[0]!.ms).toBe(15_000);
    // a hop that never ends while the timer fires: the check-in does not wait for it (its own timer, not the poll loop)
    let hopDone!: () => void;
    const longHop = new Promise<void>((r) => { hopDone = r; });
    m.clock.fire(); await settle();
    m.clock.fire(); await settle();
    expect(calls).toEqual(["running", "running", "running"]);
    hopDone(); await longHop;
  });
  test("the interval is injectable", async () => {
    const clock = fakeClock();
    const ci = createCheckIn({ api: { checkIn: async () => {} }, log: () => {}, every: clock.every, intervalMs: 50 });
    await ci.start();
    expect(clock.timers[0]!.ms).toBe(50);
    await ci.stop();
  });
  test("three failures then it works: the runner is not stopped; one `failed` line (first of the streak) and one `back` line", async () => {
    let n = 0;
    const m = mk(async () => { n++; if (n <= 3) throw new RunnerApiError(0, "network", "down"); });
    await m.ci.start();                              // fail 1 (the start one)
    m.clock.fire(); await settle();                  // fail 2
    m.clock.fire(); await settle();                  // fail 3
    m.clock.fire(); await settle();                  // works
    m.clock.fire(); await settle();                  // works again: no second `back`
    expect(m.log.filter((l) => l.includes("check-in failed"))).toHaveLength(1);
    expect(m.log.filter((l) => l.includes("check-in is back"))).toHaveLength(1);
    expect(m.log.some((l) => l.includes("network"))).toBe(true);
  });
  test("a start whose check-in fails does not throw — the runner goes on", async () => {
    const m = mk(async () => { throw new Error("boom"); });
    await expect(m.ci.start()).resolves.toBeUndefined();
  });
  test("stop(): the timer is cleared and exactly ONE `stopping` goes out, then no more (a second stop() or a late timer sends nothing)", async () => {
    const calls: string[] = [];
    const m = mk(async (s) => { calls.push(s); });
    await m.ci.start();
    await m.ci.stop();
    await m.ci.stop();
    m.clock.fire(); await settle();
    expect(calls).toEqual(["running", "stopping"]);
    expect(m.clock.timers[0]!.live).toBe(false);
  });
  test("stop() does not wait longer than its timeout for a check-in that hangs, and a failure there is only logged", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const ci = createCheckIn({ api: { checkIn: (s) => (s === "stopping" ? new Promise<void>(() => {}) : Promise.resolve()) }, log: (l) => log.push(l), every: clock.every, stopTimeoutMs: 30 });
    await ci.start();
    const t0 = Date.now();
    await ci.stop();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(log.some((l) => l.includes("stopping"))).toBe(true);
  });
  test("api.checkIn: 204 with no body is fine; the same empty body on another call is still `bad_body`", async () => {
    const seen: { url: string; body: string; actor: string | null }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen.push({ url, body: String(init?.body ?? ""), actor: new Headers(init?.headers).get("x-caw-actor") });
      return url.endsWith("/v1/runner/check-in") ? new Response(null, { status: 204 }) : new Response("", { status: 200 });
    };
    const api = createApi("http://x", "runner:t", fetchFn as typeof fetch);
    await expect(api.checkIn("running")).resolves.toBeUndefined();
    expect(seen[0]).toEqual({ url: "http://x/v1/runner/check-in", body: JSON.stringify({ state: "running" }), actor: "runner:t" });
    await expect(api.projects()).rejects.toMatchObject({ code: "bad_body" });
  });
  test("api.checkIn: a refusal (403 runner_only) still throws a RunnerApiError", async () => {
    const api = createApi("http://x", "runner:t", (async () => new Response(JSON.stringify({ error: { code: "runner_only", message: "no" } }), { status: 403 })) as unknown as typeof fetch);
    await expect(api.checkIn("running")).rejects.toMatchObject({ status: 403, code: "runner_only" });
  });
  test("through the REAL in-process API (A-093): after the first check-in GET /v1/team-status is running: true; after the `stopping` one it is false at once", async () => {
    const w = await world();
    expect((await w.call("GET", "/v1/team-status")).json.running).toBe(false);          // nobody has checked in
    const ci = createCheckIn({ api: w.api, log: (l) => w.log.push(l), every: () => () => {} });
    await ci.start();
    const up = (await w.call("GET", "/v1/team-status")).json;
    expect([up.running, up.runnerName]).toEqual([true, "test"]);                          // the actor is `runner:test`
    expect(up.lastSeenAt).not.toBeNull();
    await ci.stop();
    const down = (await w.call("GET", "/v1/team-status")).json;
    expect(down.running).toBe(false);                                                    // at once, not 45 s later
    expect(down.lastSeenAt).not.toBeNull();                                              // the last sighting is kept
  });
  test("through the REAL API: only a runner may check in — the operator gets 403 runner_only", async () => {
    const w = await world();
    const r = await w.call("POST", "/v1/runner/check-in", { state: "running" }, "operator");
    expect([r.status, r.json.error.code]).toEqual([403, "runner_only"]);
  });
});
