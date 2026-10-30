// The open workers (REQ-122, SPEC-120 D1/D3/D4/D6.2): one process per (project, worker), reused task after task, restarted by the D3 rule, dropped when it has exited.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Child } from "./hop";
import { type Procs } from "./procs";
import { WORKER_IDLE_MS, WORKER_MAX_TASKS, WORKER_MAX_TOKENS, WorkerPool, lineReader, spawnKeyOf } from "./pool";
import { type FakeChild, fakeChild } from "./testkit";

const made: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "caw-pool-")); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** no process exists, no group is alive */
const noProcs: Procs = { inspect: () => null, groupAlive: () => false, killGroup: () => {}, sleep: async () => {} };

type OpenChild = FakeChild & { written: string[]; stdinEnded: boolean };
/** a fake open `claude`: a hanging child with a stdin that records what is written to it */
function openChild(): OpenChild {
  const c = fakeChild({ hang: true }) as OpenChild;
  c.written = [];
  c.stdinEnded = false;
  c.stdin = { write: (l: string) => { c.written.push(l); }, end: () => { c.stdinEnded = true; } };
  return c;
}

function world(over: { maxTasks?: number; maxTokens?: number; idleMs?: number } = {}) {
  const tmpRoot = tmp();
  const clock = { now: 1_000_000 };
  const changes = { n: 0 };
  const logs: string[] = [];
  const pool = new WorkerPool({ tmpRoot, log: (l) => logs.push(l), now: () => clock.now, procs: noProcs, killGraceMs: 10, onChange: () => { changes.n++; }, ...over });
  const children: OpenChild[] = [];
  const spawn = () => { const c = openChild(); children.push(c); return c as Child; };
  const acquire = (hopId: string, o: { projectId?: string; workerId?: string; spawnKey?: string } = {}) =>
    pool.acquire({ projectId: o.projectId ?? "p1", workerId: o.workerId ?? "w1", hopId, spawnKey: o.spawnKey ?? "k1", cmd: ["claude"], cwd: tmpRoot, env: {}, spawn });
  return { pool, clock, changes, logs, children, acquire, tmpRoot };
}

describe("reuse", () => {
  test("one process serves task after task for the same (project, worker): one spawn, the same worker, tasks counted", async () => {
    const w = world();
    const a = await w.acquire("h1");
    w.pool.release(a, 1000);
    const b = await w.acquire("h2");
    w.pool.release(b, 2000);
    expect(b).toBe(a);
    expect(w.children).toHaveLength(1);
    expect([a.tasks, a.lastContext]).toEqual([2, 2000]);
  });
  test("a different worker or project gets its own process, and its own folder", async () => {
    const w = world();
    await w.acquire("h1", { workerId: "w1" });
    await w.acquire("h2", { workerId: "w2" });
    await w.acquire("h3", { projectId: "p2", workerId: "w1" });
    expect(w.children).toHaveLength(3);
    expect(new Set([w.pool.dirOf("p1", "w1"), w.pool.dirOf("p1", "w2"), w.pool.dirOf("p2", "w1")]).size).toBe(3);
    expect(w.pool.dirOf("p1", "w1")).toBe(join(w.tmpRoot, "worker-p1-w1"));
  });
});

describe("the restart rule (D3)", () => {
  test("after 5 tasks the next task gets a NEW process, and the old one is ended (EOF, then SIGTERM)", async () => {
    const w = world();
    expect(WORKER_MAX_TASKS).toBe(5);
    let a = await w.acquire("h0");
    for (let i = 1; i < WORKER_MAX_TASKS; i++) { w.pool.release(a, 10); a = await w.acquire(`h${i}`); }
    w.pool.release(a, 10); // the 5th task is done
    expect(w.children).toHaveLength(1);
    const next = await w.acquire("h5");
    expect(next).not.toBe(a);
    expect(w.children).toHaveLength(2);
    expect([w.children[0]!.stdinEnded, w.children[0]!.killed]).toEqual([true, true]);
    expect(next.tasks).toBe(0);
  });
  test("when the last task's context reached the token limit (150 000): a new process — 149 999 is still reused", async () => {
    expect(WORKER_MAX_TOKENS).toBe(150_000);
    const w = world();
    const a = await w.acquire("h1");
    w.pool.release(a, WORKER_MAX_TOKENS - 1);
    expect(await w.acquire("h2")).toBe(a);
    w.pool.release(a, WORKER_MAX_TOKENS);
    const b = await w.acquire("h3");
    expect(b).not.toBe(a);
    expect(w.children).toHaveLength(2);
  });
  test("the limits can be set (maxTasks 2, maxTokens 500)", async () => {
    const w = world({ maxTasks: 2, maxTokens: 500 });
    const a = await w.acquire("h1");
    w.pool.release(a, 100);
    const a2 = await w.acquire("h2");
    expect(a2).toBe(a); // 1 task done: reused
    w.pool.release(a2, 100); // 2 tasks done
    const b = await w.acquire("h3");
    expect(b).not.toBe(a); // maxTasks 2 reached
    w.pool.release(b, 500); // its context is at maxTokens 500
    const c = await w.acquire("h4");
    expect(c).not.toBe(b);
    expect(w.children).toHaveLength(3);
  });
  test("when the spawn inputs change (spawnKey) the process is ended and a new one started BEFORE the task", async () => {
    const w = world();
    const a = await w.acquire("h1", { spawnKey: "roots-A" });
    w.pool.release(a, 10);
    const same = await w.acquire("h2", { spawnKey: "roots-A" });
    expect(same).toBe(a);
    w.pool.release(same, 10);
    const b = await w.acquire("h3", { spawnKey: "roots-B" });
    expect(b).not.toBe(a);
    expect(w.children).toHaveLength(2);
    expect(w.children[0]!.killed).toBe(true);
    expect(w.logs.some((l) => l.includes("spawn inputs changed"))).toBe(true);
  });
  test("spawnKeyOf: the same parts give the same key; any one part changed gives another", () => {
    const base = { args: ["-p", "--model", "haiku"], cwd: "/r", settings: "{}", skills: "S" };
    const k = spawnKeyOf(base);
    expect(spawnKeyOf({ ...base })).toBe(k);
    for (const changed of [{ args: ["-p", "--model", "opus"] }, { cwd: "/r2" }, { settings: "{ }" }, { skills: "S2" }]) expect(spawnKeyOf({ ...base, ...changed })).not.toBe(k);
  });
  test("a process that has exited is dropped: the next task starts a new one (D4)", async () => {
    const w = world();
    const a = await w.acquire("h1");
    a.child.kill(); // the process dies under the pool
    await a.child.exited;
    await Promise.resolve();
    expect(a.alive).toBe(false);
    const b = await w.acquire("h2");
    expect(b).not.toBe(a);
    expect(w.children).toHaveLength(2);
    expect(w.logs.some((l) => l.includes("its process has exited"))).toBe(true);
  });
  test("a spawner that gives no stdin cannot make an open worker: it throws and nothing is kept", async () => {
    const w = world();
    const pool = new WorkerPool({ tmpRoot: w.tmpRoot, log: () => {}, procs: noProcs, killGraceMs: 10 });
    const bare = fakeChild({ hang: true });
    await expect(pool.acquire({ projectId: "p", workerId: "w", hopId: "h", spawnKey: "k", cmd: ["claude"], cwd: w.tmpRoot, env: {}, spawn: () => bare })).rejects.toThrow(/stdin/);
    expect(bare.killed).toBe(true);
    expect(pool.sessions()).toEqual([]);
  });
});

describe("idle workers", () => {
  test("a worker idle for the idle limit (30 min) is ended and its folder removed; before that it stays", async () => {
    expect(WORKER_IDLE_MS).toBe(1_800_000);
    const w = world();
    const a = await w.acquire("h1");
    mkdirSync(a.dir, { recursive: true });
    writeFileSync(join(a.dir, "hop"), "");
    w.pool.release(a, 10);
    w.clock.now += WORKER_IDLE_MS - 1;
    await w.pool.sweepIdle();
    expect(w.pool.sessions()).toHaveLength(1);
    expect(existsSync(a.dir)).toBe(true);
    w.clock.now += 1;
    await w.pool.sweepIdle();
    expect(w.pool.sessions()).toEqual([]);
    expect([w.children[0]!.stdinEnded, w.children[0]!.killed]).toEqual([true, true]);
    expect(existsSync(a.dir)).toBe(false);
  });
  test("a BUSY worker is never swept, however long its task takes; no new process is started by the sweep", async () => {
    const w = world({ idleMs: 1000 });
    await w.acquire("h1"); // busy: not released
    w.clock.now += 10_000;
    await w.pool.sweepIdle();
    expect(w.pool.sessions()).toEqual([{ projectId: "p1", workerId: "w1", state: "busy" }]);
    expect(w.children).toHaveLength(1);
  });
  test("an idle worker whose process died is dropped by the sweep", async () => {
    const w = world();
    const a = await w.acquire("h1");
    w.pool.release(a, 10);
    a.child.kill();
    await a.child.exited;
    await Promise.resolve();
    await w.pool.sweepIdle();
    expect(w.pool.sessions()).toEqual([]);
  });
});

describe("sessions and changes (D6.2)", () => {
  test("sessions(): `busy` while a hop runs on the worker, `idle` after release, in a stable order; an ended worker is gone", async () => {
    const w = world();
    const a = await w.acquire("h1", { workerId: "wB" });
    await w.acquire("h2", { workerId: "wA" });
    expect(w.pool.sessions()).toEqual([{ projectId: "p1", workerId: "wA", state: "busy" }, { projectId: "p1", workerId: "wB", state: "busy" }]);
    w.pool.release(a, 5);
    expect(w.pool.sessions()).toEqual([{ projectId: "p1", workerId: "wA", state: "busy" }, { projectId: "p1", workerId: "wB", state: "idle" }]);
    await w.pool.end(a, { removeDir: true });
    expect(w.pool.sessions()).toEqual([{ projectId: "p1", workerId: "wA", state: "busy" }]);
  });
  test("onChange fires when a worker opens / starts a task, ends a task, and closes", async () => {
    const w = world();
    const a = await w.acquire("h1");
    const afterOpen = w.changes.n;
    expect(afterOpen).toBeGreaterThan(0);
    w.pool.release(a, 5);
    expect(w.changes.n).toBeGreaterThan(afterOpen);
    const afterRelease = w.changes.n;
    await w.pool.end(a, { removeDir: true });
    expect(w.changes.n).toBeGreaterThan(afterRelease);
  });
  test("closeAll (the runner is stopping): every worker gets EOF, the map is emptied, no signal is sent", async () => {
    const w = world();
    await w.acquire("h1", { workerId: "w1" });
    await w.acquire("h2", { workerId: "w2" });
    w.pool.closeAll();
    expect(w.children.map((c) => c.stdinEnded)).toEqual([true, true]);
    expect(w.children.map((c) => c.killed)).toEqual([false, false]);
    expect(w.pool.sessions()).toEqual([]);
  });
});

describe("lineReader (one reader for the life of the process)", () => {
  const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } });
  test("lines cut across chunks come out whole, in order; blank lines are skipped; a last line without a newline counts; then null", async () => {
    const r = lineReader(stream(['{"a":1}\n{"b"', ':2}\n\n', '{"c":3}']), () => {});
    expect([await r.next(), await r.next(), await r.next(), await r.next(), await r.next()]).toEqual(['{"a":1}', '{"b":2}', '{"c":3}', null, null]);
  });
  test("it can be read in several goes — what one task leaves in the buffer is the next task's", async () => {
    const r = lineReader(stream(["one\ntwo\nthree\n"]), () => {});
    expect(await r.next()).toBe("one");
    expect(await r.next()).toBe("two"); // a task stopped reading here …
    expect(await r.next()).toBe("three"); // … and the next one carries on from the same stream
    expect(await r.next()).toBeNull();
  });
});
