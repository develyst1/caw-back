// The runner owns its children across its own death (TASK-C-035, REQ-012 DEF-1). Each hop's `claude` runs in its OWN process group, and the
// runner writes a small file about it. A runner that is killed hard (SIGKILL — it cannot stop its child) leaves that file behind; the next
// runner reads it and stops the leftover group BEFORE it marks the hop interrupted and starts another worker on the same card.
//
// Process group: `Bun.spawn(…, { detached: true })`. Source: the `bun-types` 1.4.2 pinned in this repo, node_modules/bun-types/bun.d.ts l.7398–7411:
//   "Run the child in a separate process group, detached from the parent. POSIX: calls `setsid()` so the child starts a new session and becomes
//   the process group leader." (The bun.com docs pages for Bun.spawn do not list the option; it was checked by running it: the child's pgid is its pid.)
//
// Identity: a pid alone is not an identity (it can be recycled). A leftover is "ours" only if the process at that pid has the recorded START TIME
// and the recorded process group — a recycled pid has neither. Not `kill-by-name`, not `pkill`: the runner's own children, found by its own record.
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type HopFile = {
  hopId: string; projectId: string;
  /** which API this runner served: two runners on two APIs share the folder, and must not touch each other's files */
  apiUrl: string;
  pid: number; pgid: number; instance: string; claudeBin: string; startedAt: string;
  /** the child's start time as `ps -o lstart=` prints it, taken right after the spawn — what tells it apart from a recycled pid */
  lstart: string;
  /** the RUNNER that wrote this file (its pid and start time): while that runner is alive the hop is its own, not an orphan */
  runnerPid: number; runnerLstart: string;
};

export type Procs = {
  /** null = no such process */
  inspect(pid: number): { lstart: string; pgid: number; command: string } | null;
  /** is any process left in this group? (a group id cannot be reused while it has members, so a live group is the recorded one) */
  groupAlive(pgid: number): boolean;
  killGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): void;
  sleep(ms: number): Promise<void>;
};

// TZ=UTC / LC_ALL=C: `lstart` is printed in local time, so a runner launched from another time zone (or locale) must still read the same text
const ps = (field: string, pid: number) =>
  Bun.spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)], { stdout: "pipe", stderr: "ignore", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).stdout.toString().trim();

export const realProcs: Procs = {
  inspect(pid) {
    const lstart = ps("lstart", pid);
    if (lstart === "") return null;
    return { lstart, pgid: Number(ps("pgid", pid)), command: ps("command", pid) };
  },
  groupAlive(pgid) {
    try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } // ESRCH = nobody left
  },
  killGroup(pgid, signal) {
    if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal process group ${pgid}`); // kill(0) = our group, kill(-1) = everything
    try { process.kill(-pgid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } // already gone is fine
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** `<os.tmpdir()>/caw-runner/hops` */
export const defaultHopsDir = () => join(tmpdir(), "caw-runner", "hops");

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const MAX_FILE = 4096; // a real file is ~300 bytes
const fileOf = (dir: string, hopId: string) => join(dir, `${hopId}.json`);
const me = () => (typeof process.getuid === "function" ? process.getuid() : -1);

/** The folder may hold only what this user put there: a directory (not a link), ours, and not writable by group or others. The tmp folder can be
 *  shared (Linux /tmp), and the files in it decide which processes get signalled. */
function folderProblem(dir: string): string | null {
  let st;
  try { st = lstatSync(dir); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `unreadable (${String(e)})`; }
  if (!st.isDirectory()) return "not a directory";
  if (st.uid !== me()) return `owned by uid ${st.uid}, not by this user`;
  if ((st.mode & 0o022) !== 0) return "writable by others";
  return null;
}

export function writeHopFile(dir: string, f: HopFile): void {
  if (!SAFE_ID.test(f.hopId)) throw new Error(`unsafe hop id for a file name: ${f.hopId}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const problem = folderProblem(dir);
  if (problem) throw new Error(`hop file folder ${dir} is not safe to use: ${problem}`);
  // Atomic: a complete temp file (created new, mode 0600, never through an existing link), then renamed over the name — a runner killed halfway
  // leaves either the whole file or none, and a link planted at the final name is replaced, not followed.
  const tmp = join(dir, `${f.hopId}.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(f), { mode: 0o600, flag: "wx" });
  renameSync(tmp, fileOf(dir, f.hopId));
}

export function removeHopFile(dir: string, hopId: string): void {
  if (!SAFE_ID.test(hopId)) return;
  try { unlinkSync(fileOf(dir, hopId)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}

const FIELDS = ["hopId", "projectId", "apiUrl", "instance", "claudeBin", "startedAt", "lstart", "runnerLstart"] as const;
export function readHopFile(dir: string, hopId: string, log: (line: string) => void): HopFile | null {
  if (!SAFE_ID.test(hopId)) return null;
  const path = fileOf(dir, hopId);
  let st;
  try { st = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; log(`hop file ${hopId}: unreadable (${String(e)}) — treated as missing`); return null; }
  try {
    const problem = folderProblem(dir);
    if (problem) throw new Error(`folder is ${problem}`);
    // lstat, not stat: a link, a FIFO (reading it would hang the runner forever) or a device is not a hop file
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.uid !== me()) throw new Error(`owned by uid ${st.uid}`);
    if (st.size > MAX_FILE) throw new Error(`${st.size} bytes is too big`);
    const f = JSON.parse(readFileSync(path, "utf8"));
    if (FIELDS.some((k) => typeof f?.[k] !== "string") || !Number.isInteger(f.pid) || !Number.isInteger(f.pgid) || !Number.isInteger(f.runnerPid)) throw new Error("fields missing");
    // pid/pgid 0 and 1 would make `kill(-pgid)` signal the runner's own group or every process of the user: never accept them from a file
    if (f.pid <= 1 || f.pgid <= 1) throw new Error(`pid ${f.pid} / pgid ${f.pgid} out of range`);
    // the child leads its own group (setsid), so a genuine file has pgid = pid; any other group number is somebody else's
    if (f.pgid !== f.pid) throw new Error(`pgid ${f.pgid} is not the pid ${f.pid}`);
    return f as HopFile;
  } catch (e) {
    log(`hop file ${hopId}: unreadable (${e instanceof Error ? e.message : String(e)}) — treated as missing`);
    return null;
  }
}

export function listHopFiles(dir: string, log: (line: string) => void): HopFile[] {
  const problem = folderProblem(dir);
  if (problem === "missing") return [];
  if (problem) { log(`hop file folder ${dir}: ${problem} — ignored`); return []; }
  return readdirSync(dir).filter((n) => n.endsWith(".json")).flatMap((n) => { const f = readHopFile(dir, n.slice(0, -5), log); return f ? [f] : []; });
}

export type ReapResult = "none" | "dead" | "not_ours" | "runner_alive" | "stopped" | "stuck";

/** Stop what is still running of this hop. Returns what it found: `none` (no file) · `dead` · `not_ours` (a recycled pid — left alone) ·
 *  `runner_alive` (the runner that started it is still running — the hop is its own, leave it) · `stopped` · `stuck` (survived SIGKILL, or the OS
 *  refused the signal — the caller must NOT start another worker on the card). Never deletes the file; the caller does. */
export async function reapLeftover(hopId: string, o: { dir: string; procs: Procs; log: (line: string) => void; graceMs?: number }): Promise<ReapResult> {
  const { procs, log } = o;
  const graceMs = o.graceMs ?? 5000;
  const f = readHopFile(o.dir, hopId, log);
  if (!f) { log(`hop ${hopId}: no hop file — nothing to stop`); return "none"; }

  if (f.pgid === procs.inspect(process.pid)?.pgid) { log(`hop ${hopId}: its recorded group ${f.pgid} is the runner's OWN — NOT touching it`); return "not_ours"; }
  // The runner that wrote the file may be alive (a second runner on the same API): then this is its worker, not an orphan.
  if (f.runnerPid !== process.pid) {
    const runner = procs.inspect(f.runnerPid);
    if (runner !== null && runner.lstart === f.runnerLstart) { log(`hop ${hopId}: the runner that started it (pid ${f.runnerPid}) is still running — leaving it alone`); return "runner_alive"; }
  }
  const proc = procs.inspect(f.pid);
  if (proc === null) {
    if (!procs.groupAlive(f.pgid)) { log(`hop ${hopId}: its process (${f.pid}) is gone`); return "dead"; }
    log(`hop ${hopId}: its leader (${f.pid}) is gone but its group ${f.pgid} still has members — stopping them`);
  } else if (proc.lstart !== f.lstart || proc.pgid !== f.pgid) {
    log(`hop ${hopId}: pid ${f.pid} is another process now (started ${proc.lstart}, recorded ${f.lstart}) — NOT touching it`);
    return "not_ours";
  } else {
    log(`hop ${hopId}: its claude (pid ${f.pid}, group ${f.pgid}) is still running — stopping the group`);
  }

  const signal = (sig: "SIGTERM" | "SIGKILL"): boolean => {
    try { procs.killGroup(f.pgid, sig); return true; } catch (e) { log(`hop ${hopId}: could not send ${sig} to group ${f.pgid}: ${e instanceof Error ? e.message : String(e)}`); return false; }
  };
  if (!signal("SIGTERM")) return "stuck"; // e.g. EPERM: the OS says it is not ours to signal — never an exception that stalls the project
  for (let waited = 0; waited < graceMs && procs.groupAlive(f.pgid); waited += 100) await procs.sleep(100);
  if (procs.groupAlive(f.pgid)) {
    log(`hop ${hopId}: group ${f.pgid} ignored SIGTERM for ${graceMs} ms — SIGKILL`);
    if (!signal("SIGKILL")) return "stuck";
    for (let waited = 0; waited < 2000 && procs.groupAlive(f.pgid); waited += 100) await procs.sleep(100);
  }
  if (procs.groupAlive(f.pgid)) { log(`hop ${hopId}: group ${f.pgid} is STILL alive after SIGKILL`); return "stuck"; }
  return "stopped";
}
