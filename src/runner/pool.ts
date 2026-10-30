// The open workers (REQ-122, SPEC-120 D1/D3/D4/D6.2). Each (project, worker) pair has ONE long-lived card process — `claude -p --input-format stream-json …` —
// and a card hop is one TASK on it: hop.ts writes one user message to its stdin and the task is over at the stream's `result` line. The process then waits, idle,
// for the next task. This file only keeps the processes: when one is reused, restarted (D3) or dropped (D4), and what it shows the check-in (D6.1/D6.2).
// Chat hops never come here: one-shot, other tools, other folder (SPEC-120 Q1).
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Child, Spawner } from "./hop";
import { type Procs, realProcs } from "./procs";

export const WORKER_MAX_TASKS = 5;
export const WORKER_MAX_TOKENS = 150_000;
export const WORKER_IDLE_MS = 1_800_000;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** After the leader is gone: is anything of its group still running (claude's MCP server, a Bash child that shrugged off SIGTERM)? Give it the grace
 *  period, then SIGKILL the group. True once the group is empty. */
export async function settleGroup(pgid: number, procs: Procs, graceMs: number, log: (line: string) => void): Promise<boolean> {
  for (let waited = 0; waited < graceMs && procs.groupAlive(pgid); waited += 100) await procs.sleep(Math.min(100, graceMs));
  if (procs.groupAlive(pgid)) {
    log(`group ${pgid}: still has processes ${graceMs} ms after its leader ended — SIGKILL`);
    try { procs.killGroup(pgid, "SIGKILL"); } catch (e) { log(`group ${pgid}: could not send SIGKILL: ${messageOf(e)}`); }
    for (let waited = 0; waited < 2000 && procs.groupAlive(pgid); waited += 100) await procs.sleep(100);
  }
  return !procs.groupAlive(pgid);
}

/** SIGTERM now, SIGKILL after the grace period if it is still there — a child must not be able to keep a hop (and the repo) forever. */
export function terminate(child: Child, graceMs: number): void {
  child.kill();
  const t = setTimeout(() => child.kill("SIGKILL"), graceMs);
  void child.exited.finally(() => clearTimeout(t));
}

/** Newline-delimited reader over a process's stdout that lives as long as the process (a task's reader must not cancel the stream the next task reads).
 *  `next()` gives the next non-empty line, or null at the end of the stream; a last line without "\n" still counts. */
export function lineReader(stream: ReadableStream<Uint8Array>, log: (line: string) => void) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let eof = false;
  return {
    async next(): Promise<string | null> {
      for (;;) {
        const i = buf.indexOf("\n");
        if (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line !== "") return line;
          continue;
        }
        if (eof) { const rest = buf; buf = ""; return rest !== "" ? rest : null; }
        const { value, done } = await reader.read();
        if (done) { buf += dec.decode(); eof = true; continue; }
        buf += dec.decode(value, { stream: true });
      }
    },
    async close(): Promise<void> { await reader.cancel().catch((e) => log(`could not close a worker's output stream: ${messageOf(e)}`)); },
  };
}
export type LineReader = ReturnType<typeof lineReader>;

export type OpenWorker = {
  key: string; projectId: string; workerId: string; child: Child; dir: string; spawnKey: string;
  /** tasks finished on this process */
  tasks: number;
  /** the context the session held at the end of its last task: the last model call's prompt (StreamSummary.lastContext) */
  lastContext: number;
  /** the hop running on it now, or null = idle */
  busyHop: string | null;
  idleSince: number;
  lines: LineReader;
  /** false once the process has exited */
  alive: boolean;
  /** what the process wrote to stderr — settles only when it exits */
  stderr: Promise<string>;
};

export type Session = { projectId: string; workerId: string; state: "idle" | "busy" };

export type PoolOptions = {
  /** the per-runner temp folder; each worker's folder is `<tmpRoot>/worker-<projectId>-<workerId>/` */
  tmpRoot: string;
  log: (line: string) => void;
  now?: () => number;
  procs?: Procs;
  killGraceMs?: number;
  maxTasks?: number; maxTokens?: number; idleMs?: number;
  /** called whenever a worker opens, closes, starts a task or ends one (the check-in is poked, not awaited) */
  onChange?: () => void;
};

export type AcquireInput = {
  projectId: string; workerId: string;
  /** the hop that is about to run on the worker */
  hopId: string;
  /** hash of everything the process was started with (see `spawnKeyOf`): a different key means a new process */
  spawnKey: string;
  cmd: string[]; cwd: string; env: Record<string, string | undefined>;
  spawn: Spawner;
};

/** sha256 of what a worker process is started from: its args, cwd, settings text and skills text (SPEC-120 D1.3) */
export const spawnKeyOf = (parts: { args: readonly string[]; cwd: string; settings: string; skills: string }): string =>
  createHash("sha256").update(JSON.stringify([parts.args, parts.cwd, parts.settings, parts.skills])).digest("hex");

export class WorkerPool {
  private workers = new Map<string, OpenWorker>();
  constructor(private o: PoolOptions) {}

  private now = () => (this.o.now ?? Date.now)();
  private grace = () => this.o.killGraceMs ?? 5000;
  private changed() { try { this.o.onChange?.(); } catch (e) { this.o.log(`pool: onChange failed: ${messageOf(e)}`); } }

  /** the folder of one open worker: `mcp.json`, `settings.json`, `skills.md` and `hop` (the running hop id, or empty) */
  dirOf(projectId: string, workerId: string): string { return join(this.o.tmpRoot, `worker-${projectId}-${workerId}`); }

  /** The open worker for this pair, ready for a task: reused as it is, or ended and started again first (D3) — after `maxTasks` tasks, when its last task's context reached `maxTokens`,
   *  when the spawn inputs changed, or when its process has exited. It is marked busy with `hopId`. */
  async acquire(a: AcquireInput): Promise<OpenWorker> {
    const key = `${a.projectId}|${a.workerId}`;
    let w = this.workers.get(key);
    if (w) {
      const why = !w.alive ? "its process has exited"
        : w.tasks >= (this.o.maxTasks ?? WORKER_MAX_TASKS) ? `it has done ${w.tasks} tasks`
        : w.lastContext >= (this.o.maxTokens ?? WORKER_MAX_TOKENS) ? `its context reached ${w.lastContext} tokens (the last call's prompt)`
        : w.spawnKey !== a.spawnKey ? "its spawn inputs changed"
        : null;
      if (why !== null) {
        this.o.log(`worker ${a.workerId} (project ${a.projectId}): starting a new process — ${why}`);
        // the folder stays: the caller has just written the new files into it
        await this.end(w, { removeDir: false });
        w = undefined;
      }
    }
    if (!w) w = this.open(key, a);
    w.busyHop = a.hopId;
    this.changed();
    return w;
  }

  private open(key: string, a: AcquireInput): OpenWorker {
    const child = a.spawn(a.cmd, { cwd: a.cwd, env: a.env, stdin: "pipe" });
    if (!child.stdin) { child.kill(); throw new Error("the spawner gave no stdin for an open worker"); }
    const w: OpenWorker = {
      key, projectId: a.projectId, workerId: a.workerId, child, dir: this.dirOf(a.projectId, a.workerId), spawnKey: a.spawnKey,
      tasks: 0, lastContext: 0, busyHop: null, idleSince: this.now(), lines: lineReader(child.stdout, this.o.log), alive: true,
      stderr: child.stderrText().catch((e) => { this.o.log(`worker ${a.workerId}: could not read claude's stderr: ${messageOf(e)}`); return ""; }), // drained from the start
    };
    this.workers.set(key, w);
    void child.exited.then(() => { w.alive = false; this.changed(); }, () => { w.alive = false; this.changed(); });
    return w;
  }

  /** a task is over (its `result` was read): the worker waits for the next one */
  release(w: OpenWorker, context: number | null): void {
    w.tasks++;
    if (context !== null) w.lastContext = context;
    w.busyHop = null;
    w.idleSince = this.now();
    this.changed();
  }

  /** End a worker's process (stdin EOF, then SIGTERM, SIGKILL after the grace period) and wait for its group to be empty. True when the group is gone.
   *  `removeDir`: its folder goes too (not when a new process is about to use the files just written). */
  async end(w: OpenWorker, o: { removeDir: boolean }): Promise<boolean> {
    if (this.workers.get(w.key) === w) this.workers.delete(w.key);
    w.busyHop = null;
    try { w.child.stdin?.end(); } catch { /* the pipe is already closed */ }
    terminate(w.child, this.grace());
    await w.lines.close();
    const gone = w.child.pid === undefined ? true : await settleGroup(w.child.pid, this.o.procs ?? realProcs, this.grace(), this.o.log);
    w.alive = false;
    if (o.removeDir) { try { rmSync(w.dir, { recursive: true, force: true }); } catch (e) { this.o.log(`worker ${w.workerId}: could not remove ${w.dir}: ${messageOf(e)}`); } }
    this.changed();
    return gone;
  }

  /** Each tick: end the workers idle for `idleMs` and drop the ones whose process has died while idle. No new process is started — a task needs it first. */
  async sweepIdle(now: number = this.now()): Promise<void> {
    for (const w of [...this.workers.values()]) {
      if (w.busyHop !== null) continue;
      if (!w.alive) await this.end(w, { removeDir: true });
      else if (now - w.idleSince >= (this.o.idleMs ?? WORKER_IDLE_MS)) {
        this.o.log(`worker ${w.workerId} (project ${w.projectId}): idle for ${Math.round((now - w.idleSince) / 1000)} s — closing it`);
        await this.end(w, { removeDir: true });
      }
    }
  }

  /** the open sessions for the check-in (D6.2): `busy` while a hop runs on the worker, else `idle` */
  sessions(): Session[] {
    return [...this.workers.values()].filter((w) => w.alive).sort((x, y) => (x.key < y.key ? -1 : 1))
      .map((w) => ({ projectId: w.projectId, workerId: w.workerId, state: w.busyHop === null ? "idle" : "busy" }));
  }

  /** The runner is stopping: every worker gets EOF (an idle one just exits; a busy one is killed by the runner with the rest, and its hop stays running for the next runner). */
  closeAll(): void {
    for (const w of this.workers.values()) {
      try { w.child.stdin?.end(); } catch { /* already closed */ }
      try { rmSync(w.dir, { recursive: true, force: true }); } catch (e) { this.o.log(`worker ${w.workerId}: could not remove ${w.dir}: ${messageOf(e)}`); }
    }
    this.workers.clear();
    this.changed();
  }
}
