// The runner's own record of its children, so a hard-killed runner's leftover `claude` can be found and stopped (TASK-C-035, DEF-1).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HopFile, type Procs, listHopFiles, readHopFile, realProcs, reapLeftover, removeHopFile, writeHopFile } from "./procs";

const made: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "caw-procs-test-")); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const file = (over: Partial<HopFile> = {}): HopFile => ({
  hopId: "h1", projectId: "p1", apiUrl: "http://api", pid: 4242, pgid: 4242, instance: "inst-A", claudeBin: "/bin/claude", startedAt: "t", lstart: "Tue Oct 14 01:00:00 2026", runnerPid: 5, runnerLstart: "Tue Oct 14 00:59:00 2026", ...over,
});

/** a fake process table: `alive` pids with their lstart/pgid; records every signal sent to a group */
function fakeProcs(table: Record<number, { lstart: string; pgid: number }>, opts: { survivesTerm?: boolean; stuck?: boolean } = {}) {
  const signals: string[] = [];
  const groups = new Set(Object.values(table).map((p) => p.pgid));
  const procs: Procs = {
    inspect: (pid) => (table[pid] ? { ...table[pid]!, command: "claude -p x" } : null),
    groupAlive: (pgid) => groups.has(pgid),
    killGroup: (pgid, sig) => {
      signals.push(`${sig} -${pgid}`);
      if (opts.stuck) return;
      if (sig === "SIGKILL" || !opts.survivesTerm) { for (const [pid, p] of Object.entries(table)) if (p.pgid === pgid) delete table[Number(pid)]; groups.delete(pgid); }
    },
    sleep: async () => {},
  };
  return { procs, signals };
}

describe("the hop file", () => {
  test("is written 0600 in a 0700 folder, and read back", () => {
    const d = join(dir(), "hops");
    writeHopFile(d, file());
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(statSync(join(d, "h1.json")).mode & 0o777).toBe(0o600);
    expect(readHopFile(d, "h1", () => {})).toEqual(file());
  });
  test("removeHopFile deletes it, and a second delete is not an error", () => {
    const d = dir();
    writeHopFile(d, file());
    removeHopFile(d, "h1"); removeHopFile(d, "h1");
    expect(existsSync(join(d, "h1.json"))).toBe(false);
  });
  test("a file that is not JSON, or lacks fields, is reported (logged) and treated as missing", () => {
    const d = dir();
    writeHopFile(d, file());
    Bun.write(join(d, "bad.json"), "not json");
    Bun.write(join(d, "thin.json"), JSON.stringify({ hopId: "thin" }));
    const log: string[] = [];
    expect(readHopFile(d, "bad", (l) => log.push(l))).toBeNull();
    expect(readHopFile(d, "thin", (l) => log.push(l))).toBeNull();
    expect(log).toHaveLength(2);
  });
  test("a hop id that could leave the folder is refused", () => {
    expect(() => writeHopFile(dir(), file({ hopId: "../x" }))).toThrow();
    expect(readHopFile(dir(), "../x", () => {})).toBeNull();
  });
  test("listHopFiles returns the valid files only", () => {
    const d = dir();
    writeHopFile(d, file({ hopId: "a" })); writeHopFile(d, file({ hopId: "b" }));
    Bun.write(join(d, "junk.txt"), "x");
    expect(listHopFiles(d, () => {}).map((f) => f.hopId).sort()).toEqual(["a", "b"]);
  });
});

describe("a hop file is untrusted input (security review)", () => {
  test("pgid must equal pid — the child leads its own group; anything else could name somebody else's group", () => {
    const d = dir();
    writeHopFile(d, file({ pid: 4242, pgid: 4300 }));
    expect(readHopFile(d, "h1", () => {})).toBeNull();
  });
  test("a group with a dead leader that is NOT the recorded pid is never signalled (it would be someone else's group)", async () => {
    const d = dir();
    writeHopFile(d, file({ pid: 4242, pgid: 9999 }));
    const signals: string[] = [];
    const procs: Procs = { inspect: () => null, groupAlive: () => true, killGroup: (g, s) => { signals.push(`${s} ${g}`); }, sleep: async () => {} };
    expect(await reapLeftover("h1", { dir: d, procs, log: () => {}, graceMs: 10 })).toBe("none");
    expect(signals).toEqual([]);
  });
  test("a folder that is writable by others is refused for writing, and read as empty", () => {
    const d = dir();
    const open = join(d, "open");
    mkdirSync(open, { mode: 0o777 }); chmodSync(open, 0o777);
    expect(() => writeHopFile(open, file())).toThrow(/writable by others|not safe/);
    const log: string[] = [];
    expect(listHopFiles(open, (l) => log.push(l))).toEqual([]);
    expect(log.length).toBeGreaterThan(0);
  });
  test("a symlink planted at <id>.json is REPLACED, not followed: the file it points to is not overwritten", () => {
    const d = dir();
    const victim = join(dir(), "victim.txt");
    writeFileSync(victim, "precious");
    symlinkSync(victim, join(d, "h1.json"));
    writeHopFile(d, file());
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(readHopFile(d, "h1", () => {})).toEqual(file());
  });
  test("reading a symlink, a directory, or an oversized file gives null and a log line, not a hang or a crash", () => {
    const d = dir();
    const target = join(dir(), "t.json");
    writeFileSync(target, JSON.stringify(file({ hopId: "link" })));
    symlinkSync(target, join(d, "link.json"));
    mkdirSync(join(d, "isdir.json"));
    writeFileSync(join(d, "big.json"), "x".repeat(10_000));
    const log: string[] = [];
    for (const id of ["link", "isdir", "big"]) expect(readHopFile(d, id, (l) => log.push(l))).toBeNull();
    expect(log).toHaveLength(3);
  });
  test("the write is atomic: the final file is complete and no temp file is left behind", () => {
    const d = dir();
    writeHopFile(d, file());
    expect(readdirSync(d)).toEqual(["h1.json"]);
  });
});

describe("a hop file can never make the runner signal the wrong thing (a corrupt or hostile file)", () => {
  test.each([[0, 0], [1, 1], [-5, -5], [4242, 0], [4242, 1], [4242, -1]])("pid %i / pgid %i is refused when read", (pid, pgid) => {
    const d = dir();
    writeHopFile(d, file({ pid, pgid }));
    const log: string[] = [];
    expect(readHopFile(d, "h1", (l) => log.push(l))).toBeNull();
    expect(log).toHaveLength(1);
  });
  test("realProcs.killGroup refuses group 0 and 1 (kill(0) is OUR group, kill(-1) is everything)", () => {
    for (const g of [0, 1, -3, 1.5]) expect(() => realProcs.killGroup(g, "SIGTERM")).toThrow();
  });
  test("a file naming the runner's OWN process group is not ours to kill (whatever the leader's state)", async () => {
    const mine = realProcs.inspect(process.pid)!;
    const leader = realProcs.inspect(mine.pgid);                                            // the leader of OUR group, if it still exists
    const d = dir();
    writeHopFile(d, file({ hopId: "self", pid: mine.pgid, pgid: mine.pgid, lstart: leader?.lstart ?? "x" }));
    const signals: string[] = [];
    const procs: Procs = { ...realProcs, killGroup: (g, s) => { signals.push(`${s} ${g}`); } };
    expect(await reapLeftover("self", { dir: d, procs, log: () => {}, graceMs: 10 })).toBe("not_ours");
    expect(signals).toEqual([]);
  });
});

describe("reapLeftover — before a hop is marked interrupted, stop what is still running of it", () => {
  const run = (t: ReturnType<typeof fakeProcs>, d: string, graceMs = 50) => reapLeftover("h1", { dir: d, procs: t.procs, log: () => {}, graceMs });

  test("no hop file → `none`, nothing signalled (as before this TASK)", async () => {
    const t = fakeProcs({});
    expect(await run(t, dir())).toBe("none");
    expect(t.signals).toEqual([]);
  });
  test("the process is gone and so is its group → `dead`, nothing signalled", async () => {
    const d = dir(); writeHopFile(d, file());
    const t = fakeProcs({});
    expect(await run(t, d)).toBe("dead");
    expect(t.signals).toEqual([]);
  });
  test("alive and the same process (start time and group match) → SIGTERM to the GROUP, then it is gone → `stopped`", async () => {
    const d = dir(); writeHopFile(d, file());
    const t = fakeProcs({ 4242: { lstart: "Tue Oct 14 01:00:00 2026", pgid: 4242 } });
    expect(await run(t, d)).toBe("stopped");
    expect(t.signals).toEqual(["SIGTERM -4242"]);
  });
  test("it ignores SIGTERM → SIGKILL to the group after the grace period", async () => {
    const d = dir(); writeHopFile(d, file());
    const t = fakeProcs({ 4242: { lstart: "Tue Oct 14 01:00:00 2026", pgid: 4242 } }, { survivesTerm: true });
    expect(await run(t, d)).toBe("stopped");
    expect(t.signals).toEqual(["SIGTERM -4242", "SIGKILL -4242"]);
  });
  test("a RECYCLED pid (same number, different start time) is never signalled → `not_ours`", async () => {
    const d = dir(); writeHopFile(d, file());
    const t = fakeProcs({ 4242: { lstart: "Wed Oct 15 09:30:00 2026", pgid: 4242 } });
    expect(await run(t, d)).toBe("not_ours");
    expect(t.signals).toEqual([]);
  });
  test("same pid and start time but another process group → `not_ours` too", async () => {
    const d = dir(); writeHopFile(d, file());
    const t = fakeProcs({ 4242: { lstart: "Tue Oct 14 01:00:00 2026", pgid: 1 } });
    expect(await run(t, d)).toBe("not_ours");
    expect(t.signals).toEqual([]);
  });
  test("the leader is dead but the group still has members (claude\'s MCP server, a Bash child) → they are stopped; a live group cannot be a recycled pid", async () => {
    const d = dir(); writeHopFile(d, file());
    const t = fakeProcs({ 9001: { lstart: "x", pgid: 4242 } }); // not the leader pid 4242, but in its group
    expect(await run(t, d)).toBe("stopped");
    expect(t.signals).toEqual(["SIGTERM -4242"]);
  });
  test("a signal the OS refuses (EPERM: not our group) is `stuck`, not an exception that stalls the project", async () => {
    const d = dir(); writeHopFile(d, file());
    const t = fakeProcs({ 4242: { lstart: "Tue Oct 14 01:00:00 2026", pgid: 4242 } });
    t.procs.killGroup = () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); };
    const log: string[] = [];
    expect(await reapLeftover("h1", { dir: d, procs: t.procs, log: (l) => log.push(l), graceMs: 10 })).toBe("stuck");
    expect(log.some((l) => l.includes("operation not permitted"))).toBe(true);
  });
  test("the runner that wrote the file is STILL ALIVE (same pid, same start time) → `runner_alive`: its worker is not an orphan and is left alone", async () => {
    const d = dir(); writeHopFile(d, file());
    const t = fakeProcs({ 4242: { lstart: "Tue Oct 14 01:00:00 2026", pgid: 4242 }, 5: { lstart: "Tue Oct 14 00:59:00 2026", pgid: 5 } });
    expect(await run(t, d)).toBe("runner_alive");
    expect(t.signals).toEqual([]);
  });
  test("a recycled number for the runner (different start time) does not protect the leftover", async () => {
    const d = dir(); writeHopFile(d, file());
    const t = fakeProcs({ 4242: { lstart: "Tue Oct 14 01:00:00 2026", pgid: 4242 }, 5: { lstart: "Thu Oct 16 08:00:00 2026", pgid: 5 } });
    expect(await run(t, d)).toBe("stopped");
  });
  test("a file written by THIS process is not 'another runner alive' (its own earlier hop)", async () => {
    const d = dir(); writeHopFile(d, file({ runnerPid: process.pid, runnerLstart: "Tue Oct 14 00:59:00 2026" }));
    const t = fakeProcs({ 4242: { lstart: "Tue Oct 14 01:00:00 2026", pgid: 4242 } });
    const base = t.procs.inspect;
    t.procs.inspect = (pid) => (pid === process.pid ? { lstart: "Tue Oct 14 00:59:00 2026", pgid: 1234, command: "bun" } : base(pid));
    expect(await run(t, d)).toBe("stopped");
  });
  test("a group that survives even SIGKILL → `stuck` (the caller must NOT start a second worker on the card)", async () => {
    const d = dir(); writeHopFile(d, file());
    const t = fakeProcs({ 4242: { lstart: "Tue Oct 14 01:00:00 2026", pgid: 4242 } }, { stuck: true });
    expect(await run(t, d)).toBe("stuck");
  });
});

describe("REAL processes (no fakes): a detached group is found by its hop file and stopped, including a grandchild", () => {
  test("`sh -c 'sleep 30 & wait'` started detached: its pid is its pgid, and reapLeftover ends both processes", async () => {
    const d = dir();
    const p = Bun.spawn(["sh", "-c", "sleep 30 & wait"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const info = realProcs.inspect(p.pid)!;
    expect(info.pgid).toBe(p.pid);                                                     // its own group
    expect(info.pgid).not.toBe(realProcs.inspect(process.pid)!.pgid);                  // not ours
    writeHopFile(d, file({ hopId: "real", pid: p.pid, pgid: p.pid, lstart: info.lstart }));
    expect(realProcs.groupAlive(p.pid)).toBe(true);
    const r = await reapLeftover("real", { dir: d, procs: realProcs, log: () => {}, graceMs: 2000 });
    await p.exited;
    expect(r).toBe("stopped");
    expect(realProcs.inspect(p.pid)).toBeNull();
    expect(realProcs.groupAlive(p.pid)).toBe(false);                                   // the sleep is gone with its shell
  });
  test("the start time does not depend on the TZ the runner was launched with (a laptop that travelled must not turn a live worker into a stranger)", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const a = realProcs.inspect(process.pid)!.lstart;
      process.env.TZ = "Pacific/Auckland";
      const b = realProcs.inspect(process.pid)!.lstart;
      expect(b).toBe(a);
    } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
  });
  test("a real process that is NOT the recorded one (same pid number claimed, wrong start time) survives", async () => {
    const d = dir();
    const p = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      writeHopFile(d, file({ hopId: "other", pid: p.pid, pgid: p.pid, lstart: "Mon Jan  1 00:00:00 2001" }));
      const r = await reapLeftover("other", { dir: d, procs: realProcs, log: () => {}, graceMs: 100 });
      expect(r).toBe("not_ours");
      expect(realProcs.inspect(p.pid)).not.toBeNull();
    } finally { process.kill(-p.pid, "SIGKILL"); await p.exited; }
  });
});
