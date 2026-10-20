// runHop against the REAL app on PGlite (test/helpers, imported not edited) and a FAKE `claude` child (a stream of recorded lines).
// What the fake child does through MCP in a real hop (comment, hand_off …) the test does through the API as that worker.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainOf3, newCard, setup } from "../../test/helpers/api";
import { RunnerApiError, createApi } from "./api";
import { HOOKS } from "./config";
import { type Child, type HopDeps, NOTES, buildArgs, buildMcpConfig, childEnv, runHop } from "./hop";
import { type Procs, readHopFile } from "./procs";
import { fakeChild, fixture, hopAware, limitFixture } from "./testkit";
import { formatReset } from "./thai";

const made: string[] = []; // every temp folder a test makes, removed in afterAll
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const WS = tmp("caw-hop-ws-");
mkdirSync(join(WS, ".claude/skills/role-be"), { recursive: true });
writeFileSync(join(WS, ".claude/skills/role-be/SKILL.md"), "BE craft");

/** the runner's base settings file, which every hop extends with its own read fence (TASK-C-042) */
const baseSettings = join(tmp("caw-hop-base-"), "settings.json");
writeFileSync(baseSettings, JSON.stringify({ permissions: { allow: [], deny: [] }, sandbox: { enabled: true }, hooks: { PreToolUse: [] } }));

async function world(over: { roots?: string[]; skills?: string[]; hopMaxMs?: number } = {}) {
  const t0 = await setup();
  const t = { ...t0, call: hopAware(t0.call) }; // a worker's write names its running hop (contract v1.5)
  const { project, a } = await chainOf3(t.call);
  const worker = (await t.call("POST", "/v1/workers", { name: "Blew", role: "BE", skills: over.skills ?? ["role-be"], model: "haiku", effort: "low" })).json;
  await t.call("POST", `/v1/projects/${project.id}/chain/members`, { workerId: worker.id });
  const rootA = tmp("caw-hop-root-");
  const rootB = tmp("caw-hop-root-");
  const roots = over.roots ?? [rootA, rootB];
  if (roots.length) { const r = await t.call("PATCH", `/v1/projects/${project.id}/workspace`, { roots }); if (r.status !== 200) throw new Error(JSON.stringify(r.json)); }
  const card = (await newCard(t.call, project.id, { assigneeId: worker.id })).json;
  const other = (await newCard(t.call, project.id, { title: "another card", assigneeId: worker.id })).json;
  const api = createApi("http://caw.test", "runner:inst-1", (url, init) => t.app.fetch(new Request(url, init)));
  const actor = `worker:${worker.id}`;
  const hop = await api.startHop(project.id, { cardId: card.id, workerId: worker.id, claim: "inst-1" });
  const tmpRoot = tmp("caw-hop-tmp-");
  const spawned: { cmd: string[]; cwd: string }[] = [];
  let next: () => Child = () => fakeChild({ lines: fixture("ok") });
  const log: string[] = [];
  const deps: HopDeps = {
    api, tmpRoot, log: (l) => log.push(l), cursors: new Map(), settingsFile: baseSettings,
    config: { apiUrl: "http://127.0.0.1:4530", pollMs: 10, hopMaxMs: over.hopMaxMs ?? 5000, claudeBin: "/bin/claude", workspaceRoot: WS, hooks: HOOKS.map((h) => `${WS}/scripts/hooks/${h}`) },
    spawn: (cmd, opts) => { spawned.push({ cmd, cwd: opts.cwd }); return next(); },
  };
  const input = async () => ({ project: (await api.projects()).find((p) => p.id === project.id)!, hop, worker: (await api.workers()).find((w) => w.id === worker.id)!, card: await api.card(card.id) });
  const finished = async () => (await api.hops(project.id)).find((h) => h.id === hop.id)!;
  return { ...t, api, deps, input, finished, hop, spawned, log, project, worker, card, other, actor, set: (f: () => Child) => { next = f; }, tmpRoot };
}

describe("runHop — outcome comes from what the worker wrote to the store", () => {
  test("a comment through MCP → outcome commented, tokens from the result line, empty note, no leftovers on disk", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: fixture("ok"), before: async () => { await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "done" }, w.actor); } }));
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(h.outcome).toBe("commented");
    expect(h.tokensIn).toBe(10 + 13124 + 22383);
    expect(h.tokensOut).toBe(455);
    expect(h.note).toBe("");
    expect(h.endedAt).not.toBeNull();
    expect(existsSync(join(w.tmpRoot, `hop-${h.id}`))).toBe(false);
  });

  test("the LAST write by this worker on this card decides: comment then set_status → status", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: fixture("ok"), before: async () => {
      await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "c" }, w.actor);
      await w.call("PATCH", `/v1/cards/${w.card.id}/status`, { status: "review" }, w.actor);
    } }));
    await runHop(w.deps, await w.input());
    expect((await w.finished()).outcome).toBe("status");
  });

  test("a hand_off → handed_off", async () => {
    const w = await world();
    const target = (await w.call("POST", "/v1/workers", { name: "Next", role: "QA", skills: ["x"] })).json;
    await w.call("POST", `/v1/projects/${w.project.id}/chain/members`, { workerId: target.id });
    await w.call("POST", `/v1/projects/${w.project.id}/chain/edges`, { from: w.worker.id, to: target.id });
    w.set(() => fakeChild({ lines: fixture("ok"), before: async () => {
      const r = await w.call("POST", `/v1/cards/${w.card.id}/handoff`, { toWorkerId: target.id, text: "over to you" }, w.actor);
      if (r.status !== 200 && r.status !== 201) throw new Error(JSON.stringify(r.json));
    } }));
    await runHop(w.deps, await w.input());
    expect((await w.finished()).outcome).toBe("handed_off");
  });

  test("a question → asked (the event names the card as askingCardId)", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: fixture("ok"), before: async () => {
      const r = await w.call("POST", `/v1/cards/${w.card.id}/question`, { text: "which?", proposedDefault: "A", cases: ["x"] }, w.actor);
      if (r.status !== 201 && r.status !== 200) throw new Error(JSON.stringify(r.json));
    } }));
    await runHop(w.deps, await w.input());
    expect((await w.finished()).outcome).toBe("asked");
  });

  test("a write on ANOTHER card, or by ANOTHER actor, is not this hop's result → failed, with the no-result note", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: fixture("ok"), before: async () => {
      await w.call("POST", `/v1/cards/${w.other.id}/comments`, { text: "elsewhere" }, w.actor);
      await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "by the operator" }, "operator");
    } }));
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(h.outcome).toBe("failed");
    expect(h.note.startsWith(`${NOTES.noResult} · tools:`)).toBe(true);
  });

  test("a write from BEFORE the hop started is not counted (events after the start seq only)", async () => {
    const w = await world();
    await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "old" }, w.actor);
    await runHop(w.deps, await w.input());
    expect((await w.finished()).outcome).toBe("failed");
  });
});

describe("runHop — refusals and stops (the child is never started for a refusal)", () => {
  test("no roots → stopped, the no-folders note, claude not spawned", async () => {
    const w = await world({ roots: [] });
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect([h.outcome, h.note]).toEqual(["stopped", NOTES.noRoots]);
    expect(w.spawned).toHaveLength(0);
  });

  test("a missing skill → stopped, naming it, claude not spawned", async () => {
    const w = await world({ skills: ["role-be", "ghost-skill"] });
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect([h.outcome, h.note]).toEqual(["stopped", NOTES.skillMissing("ghost-skill")]);
    expect(w.log.some((l) => l.includes(h.id) && l.includes("ghost-skill"))).toBe(true);    // and the runner's log says it too (the hop row is not the only place)
    expect(w.spawned).toHaveLength(0);
  });

  test("a hook block in the stream ends the child at once and the hop is stopped with the worker and the action", async () => {
    const w = await world();
    const child = fakeChild({ lines: fixture("push-absolute-hooks").slice(0, -1), hang: true }); // the stream never reaches its result: the runner must not wait for it
    w.set(() => child);
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(child.killed).toBe(true);
    expect(h.outcome).toBe("stopped");
    expect(h.note).toBe("หยุดไว้: Blew พยายาม Bash: git push origin HEAD ซึ่งไม่อนุญาต · tools: Bash ×1 · turns 1");
    // the exact block text goes to the runner's log, so an operator can see WHAT stopped it (the note is the short Thai form)
    expect(w.log.join("\n")).toContain("hook block: PreToolUse:Bash hook error:");
  });

  test("a permission denial ends it the same way", async () => {
    const w = await world();
    const child = fakeChild({ lines: fixture("write-outside").slice(0, -1), hang: true });
    w.set(() => child);
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(child.killed).toBe(true);
    expect([h.outcome, h.note.startsWith("หยุดไว้: Blew พยายาม Bash: mkdir -p ")]).toEqual(["stopped", true]);
  });

  test("a child that outlives RUNNER_HOP_MAX_MS is killed → stopped, timeout note", async () => {
    const w = await world({ hopMaxMs: 40 });
    const child = fakeChild({ hang: true });
    w.set(() => child);
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(child.killed).toBe(true);
    expect([h.outcome, h.note.startsWith(`${NOTES.timeout} · tools:`)]).toEqual(["stopped", true]);
  });

  test("when the RUNNER is stopping, a child that dies with it leaves the hop RUNNING — the next runner marks it interrupted (found by the restart e2e)", async () => {
    const w = await world();
    const child = fakeChild({ hang: true });
    w.set(() => child);
    w.deps.stopping = () => true;
    const run = runHop(w.deps, await w.input());
    await new Promise((r) => setTimeout(r, 20));
    child.kill(); // what the runner's SIGTERM handler does to its children
    await run;
    const h = await w.finished();
    expect([h.endedAt, h.outcome]).toEqual([null, null]);
    expect(w.log.join("\n")).toContain("runner is stopping");
  });

  test("a spawn that throws (claude not installed) still ends the hop — failed, with the reason, and it is logged", async () => {
    const w = await world();
    w.deps.spawn = () => { throw new Error("ENOENT claude"); };
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(h.outcome).toBe("failed");
    expect(h.note).toContain("ENOENT claude");
    expect(w.log.join("\n")).toContain("ENOENT claude");
  });
});

describe("runHop — robustness (the silent-failure review)", () => {
  test("a stdout pipe that errors mid-stream: the child is killed — no unguarded worker left running — and the hop FAILS with the reason", async () => {
    const w = await world();
    const child = fakeChild({ hang: true, fail: new Error("pipe broke") });
    w.set(() => child);
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(child.killed).toBe(true);
    expect([h.outcome, h.note]).toEqual(["failed", "ตัวรันขัดข้อง: pipe broke"]); // the PM's word (REQ-012)
  });

  test("a child that ignores SIGTERM is SIGKILLed after the grace period, and the hop still ends (stopped, timeout)", async () => {
    const w = await world({ hopMaxMs: 20 });
    const child = fakeChild({ hang: true, ignoreTerm: true });
    w.set(() => child);
    w.deps.killGraceMs = 30;
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect([h.outcome, h.note.startsWith(`${NOTES.timeout} · tools:`)]).toEqual(["stopped", true]);
  });

  test("the runner already stopping: claude is never spawned (no child may outlive the runner) and the hop stays running", async () => {
    const w = await world();
    w.deps.stopping = () => true;
    await runHop(w.deps, await w.input());
    expect(w.spawned).toHaveLength(0);
    expect((await w.finished()).endedAt).toBeNull();
  });

  test("an API that clamps its page size below 500 still yields the worker's event (paging reads until an empty page)", async () => {
    const w = await world();
    const real = w.deps.api;
    w.deps.api = { ...real, events: async (p, after) => (await real.events(p, after, 500)).slice(0, 2) };
    w.set(() => fakeChild({ lines: fixture("ok"), before: async () => {
      for (const t of ["a", "b", "c"]) await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: t }, w.actor);
    } }));
    await runHop(w.deps, await w.input());
    expect((await w.finished()).outcome).toBe("commented");
  });

  test("the exit code is logged on the stopped path too, not only after a normal end", async () => {
    const w = await world({ hopMaxMs: 20 });
    w.set(() => fakeChild({ hang: true }));
    await runHop(w.deps, await w.input());
    expect(w.log.join("\n")).toContain("claude exit 143");
  });

  test("lines claude printed that are not JSON are counted in the log", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: ["Error: plain text on stdout", ...fixture("ok")] }));
    await runHop(w.deps, await w.input());
    expect(w.log.join("\n")).toContain("1 line(s) were not JSON");
  });
});

describe("runHop — the subscription limit (REQ-012 R6)", () => {
  const RESETS = 1791898200; // the recorded rate_limit_event's resetsAt
  test("a rate_limit_event that is not `allowed` ends the child at once: the hop is stopped with the Thai reset time, and the limit is handed back", async () => {
    const w = await world();
    const now = new Date("2026-10-13T10:00:00Z");
    w.deps.now = () => now;
    const child = fakeChild({ lines: limitFixture().slice(0, 14), hang: true }); // the stream stops after the event: the runner must not wait for a result
    w.set(() => child);
    const r = await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(child.killed).toBe(true);
    expect([h.outcome, h.note]).toEqual(["stopped", `ถึงลิมิตการใช้งาน Claude — จะทำต่อได้หลัง ${formatReset(RESETS, now)}`]);
    expect(r.limit).toEqual({ status: "rejected", resetsAt: RESETS });
    expect(r.hop.id).toBe(h.id);
  });
  test("an `allowed_warning` event does not stop the hop (it is still allowed to work)", async () => {
    const w = await world();
    const lines = fixture("ok").map((l) => { const m = JSON.parse(l); if (m.type === "rate_limit_event") m.rate_limit_info.status = "allowed_warning"; return JSON.stringify(m); });
    w.set(() => fakeChild({ lines, before: async () => { await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "c" }, w.actor); } }));
    const r = await runHop(w.deps, await w.input());
    expect(r.limit).toBeNull();
    expect((await w.finished()).outcome).toBe("commented");
  });
  test("a stream with only `allowed` events is no limit", async () => {
    const w = await world();
    const r = await runHop(w.deps, await w.input());
    expect(r.limit).toBeNull();
  });
  test("a limit event without a reset time still stops the hop, with the words that need none", async () => {
    const w = await world();
    const lines = limitFixture().map((l) => { const m = JSON.parse(l); if (m.type === "rate_limit_event") delete m.rate_limit_info.resetsAt; return JSON.stringify(m); });
    w.set(() => fakeChild({ lines: lines.slice(0, 14), hang: true }));
    await runHop(w.deps, await w.input());
    expect((await w.finished()).note).toBe("ถึงลิมิตการใช้งาน Claude");
  });
});

describe("runHop — the exit code, and secrets (Sector's review)", () => {
  test("a child that exits non-zero after posting: still `commented` (SPEC § 2), and the note says `exit <n>`", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: fixture("ok"), exitCode: 3, before: async () => { await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "c" }, w.actor); } }));
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect([h.outcome, h.note]).toEqual(["commented", "exit 3"]);
  });
  test("a child that exits non-zero and wrote nothing: failed, the no-result note plus the exit code", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: fixture("ok"), exitCode: 1 }));
    await runHop(w.deps, await w.input());
    expect((await w.finished()).note.startsWith(`${NOTES.noResult} · exit 1 · tools:`)).toBe(true);
  });
  test("exit 0 leaves the note empty", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: fixture("ok"), before: async () => { await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "c" }, w.actor); } }));
    await runHop(w.deps, await w.input());
    expect((await w.finished()).note).toBe("");
  });
  test("a blocked command that carries a secret: the stored note and the log show it redacted", async () => {
    const w = await world();
    const cmd = "git push https://bob:s3cret@example.invalid/r.git token=abc999";
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: cmd } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: `PreToolUse:Bash hook error: [/x/block-irreversible.sh]: Blocked (git push) ${cmd}` }] } }),
    ];
    w.set(() => fakeChild({ lines, hang: true }));
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(h.outcome).toBe("stopped");
    for (const text of [h.note, w.log.join("\n")]) { expect(text).not.toContain("s3cret"); expect(text).not.toContain("abc999"); }
    expect(h.note).toContain("git push https://***@example.invalid/r.git token=***");
  });
  test("a runner fault's text is redacted too", async () => {
    const w = await world();
    w.deps.spawn = () => { throw new Error("cannot start https://u:pw12345@host/x"); };
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(h.note).not.toContain("pw12345");
    expect(w.log.join("\n")).not.toContain("pw12345");
  });
  test("the init message and the token breakdown are logged once per hop", async () => {
    const w = await world();
    await runHop(w.deps, await w.input());
    const line = w.log.find((l) => l.includes("init:"))!;
    expect(line).toContain('"tools":32');
    expect(line).toContain("cacheCreation 13124");
  });
});

describe("what the child may see of the runner's environment (security review F4)", () => {
  test("only the login/shell basics pass; keys, tokens and cloud credentials do not", () => {
    const env = childEnv({
      PATH: "/bin", HOME: "/Users/x", USER: "x", LOGNAME: "x", LANG: "en_US.UTF-8", TMPDIR: "/tmp", SHELL: "/bin/zsh",
      ANTHROPIC_API_KEY: "k", AWS_SECRET_ACCESS_KEY: "s", GH_TOKEN: "g", DATABASE_URL: "postgres://u:p@h/d", CAW_WORKSPACE_ROOT: "/ws", SSH_AUTH_SOCK: "/s",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/Users/x", USER: "x", LOGNAME: "x", LANG: "en_US.UTF-8", TMPDIR: "/tmp", SHELL: "/bin/zsh" });
  });
  test("a variable that is not set is left out, not set to undefined", () => {
    expect(Object.keys(childEnv({ PATH: "/bin" }))).toEqual(["PATH"]);
  });
  test("runHop starts claude with that environment, not the whole one", async () => {
    const w = await world();
    process.env.CAW_TEST_SECRET = "must-not-leak";
    let seen: Record<string, string | undefined> = {};
    w.deps.spawn = (cmd, opts) => { seen = opts.env; return fakeChild({ lines: fixture("ok") }); };
    try { await runHop(w.deps, await w.input()); } finally { delete process.env.CAW_TEST_SECRET; }
    expect(seen.CAW_TEST_SECRET).toBeUndefined();
    expect(seen.PATH).toBe(process.env.PATH);
  });
});

describe("the hop file and the process group (TASK-C-035, DEF-1)", () => {
  const stubProcs = (): Procs => ({ inspect: (pid) => ({ lstart: `started-${pid}`, pgid: pid, command: "claude" }), groupAlive: () => false, killGroup: () => {}, sleep: async () => {} });
  const withDir = async (over: object = {}) => {
    const w = await world();
    const hopsDir = tmp("caw-hop-files-");
    w.deps.hopsDir = hopsDir;
    w.deps.procs = stubProcs();
    w.deps.instance = "inst-1";
    return { w, hopsDir, ...over };
  };

  test("while the child runs there is a file for it: pid, group, instance, claudeBin, start time — and it is gone once the hop has ended", async () => {
    const { w, hopsDir } = await withDir();
    let during: ReturnType<typeof readHopFile> = null;
    w.set(() => fakeChild({ pid: 4321, lines: fixture("ok"), before: async () => { during = readHopFile(hopsDir, (await w.finished()).id, () => {}); } }));
    await runHop(w.deps, await w.input());
    expect(during).toMatchObject({ hopId: (await w.finished()).id, projectId: w.project.id, pid: 4321, pgid: 4321, instance: "inst-1", claudeBin: "/bin/claude", apiUrl: "http://127.0.0.1:4530", lstart: "started-4321" });
    expect(readHopFile(hopsDir, (await w.finished()).id, () => {})).toBeNull();
  });
  test("the file is removed also when the hop ends stopped or failed", async () => {
    const { w, hopsDir } = await withDir();
    w.set(() => fakeChild({ pid: 4321, lines: fixture("push-absolute-hooks").slice(0, 15), hang: true }));
    await runHop(w.deps, await w.input());
    expect((await w.finished()).outcome).toBe("stopped");
    expect(readHopFile(hopsDir, (await w.finished()).id, () => {})).toBeNull();
  });
  test("a runner that is stopping LEAVES the file (the next runner reads it)", async () => {
    const { w, hopsDir } = await withDir();
    const child = fakeChild({ pid: 4321, hang: true });
    w.set(() => child);
    w.deps.stopping = () => child.killed;
    const run = runHop(w.deps, await w.input());
    await new Promise((r) => setTimeout(r, 30));
    child.kill();
    await run;
    expect(readHopFile(hopsDir, (await w.finished()).id, () => {})).not.toBeNull();
  });
  test("the leader exits but a straggler of its group does not (an MCP server, a Bash child that ignores SIGTERM): the group is SIGKILLed and the file stays until the group is empty", async () => {
    const { w, hopsDir } = await withDir();
    let alive = true;
    const signals: string[] = [];
    w.deps.procs = { ...stubProcs(), groupAlive: () => alive, killGroup: (g, s) => { signals.push(`${s} -${g}`); if (s === "SIGKILL") alive = false; } };
    w.deps.killGraceMs = 30;
    w.set(() => fakeChild({ pid: 4321, lines: fixture("ok") }));
    await runHop(w.deps, await w.input());
    expect(signals).toEqual(["SIGKILL -4321"]);
    expect(readHopFile(hopsDir, (await w.finished()).id, () => {})).toBeNull();       // gone once the group is
  });
  test("a group that survives even that keeps its hop file (the next runner\'s sweep finds it) and says so", async () => {
    const { w, hopsDir } = await withDir();
    w.deps.procs = { ...stubProcs(), groupAlive: () => true, killGroup: () => {} };
    w.deps.killGraceMs = 20;
    w.set(() => fakeChild({ pid: 4321, lines: fixture("ok") }));
    await runHop(w.deps, await w.input());
    expect(readHopFile(hopsDir, (await w.finished()).id, () => {})).not.toBeNull();
    expect(w.log.some((l) => l.includes("still alive") && l.includes("hop file"))).toBe(true);
  });
  test("a child without a pid (a fake) writes no file", async () => {
    const { w, hopsDir } = await withDir();
    await runHop(w.deps, await w.input());
    expect(Bun.spawnSync(["ls", hopsDir]).stdout.toString()).toBe("");
  });
  test("the real spawner starts the child in its OWN process group (detached) — its pgid is its pid, not the runner\'s", async () => {
    const { bunSpawn } = await import("./hop");
    const { realProcs } = await import("./procs");
    const child = bunSpawn(["sleep", "30"], { cwd: tmpdir(), env: { PATH: process.env.PATH } });
    try {
      expect(child.pid).toBeGreaterThan(1);
      const info = realProcs.inspect(child.pid!)!;
      expect(info.pgid).toBe(child.pid!);
      expect(info.pgid).not.toBe(realProcs.inspect(process.pid)!.pgid);
    } finally { child.kill(); await child.exited; }
    expect(realProcs.groupAlive(child.pid!)).toBe(false);                      // kill() stopped the group, not just the pid
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
describe("a chat hop: the entry worker answers an operator message (TASK-C-034)", () => {
  /** world() with the worker made the project's ENTRY worker, an operator message, and a chat hop on it (the card hop world() starts is finished first) */
  async function chatWorld() {
    const w = await world();
    await w.api.finishHop(w.hop.id, { outcome: "commented" });
    await w.call("PUT", `/v1/projects/${w.project.id}/chain/entry`, { workerId: w.worker.id });
    const msg = (await w.call("POST", `/v1/projects/${w.project.id}/chat`, { text: "แก้ขั้นอนุมัติห้องใหญ่" })).json;
    const chatHop = await w.api.startHop(w.project.id, { messageId: msg.id, workerId: w.worker.id, claim: "inst-1" });
    const H = { "x-caw-hop": chatHop.id };
    const P = `/v1/projects/${w.project.id}`;
    const as = (method: string, path: string, body?: unknown) => w.call(method, path, body, w.actor, H);
    const input = async () => ({ project: (await w.api.projects()).find((p) => p.id === w.project.id)!, hop: chatHop, worker: (await w.api.workers()).find((x) => x.id === w.worker.id)! });
    const finishedChat = async () => (await w.api.hops(w.project.id)).find((h) => h.id === chatHop.id)!;
    // what the worker does through the five MCP tools, as API calls
    const locate = (request = "แก้ขั้นอนุมัติห้องใหญ่") => as("POST", `${P}/locate`, { request });
    const propose = async () => (await as("POST", `${P}/proposals`, { messageId: msg.id, items: [{ title: "ทำหน้าอนุมัติ", todo: "ตาม STEP-004", anchor: { key: "STEP-004", version: 1 }, workerId: w.worker.id, dependsOn: [], hops: 2 }] })).json;
    const amend = async () => (await as("POST", `${P}/amendments`, { request: "ขอเพิ่มเรื่องจ่ายเงินเดือน" })).json;
    const reply = (extra: object = {}) => as("POST", `/v1/chat/${msg.id}/reply`, { text: "รับทราบ", ...extra });
    return { ...w, msg, chatHop, input, finishedChat, locate, propose, amend, reply };
  }
  const run = async (c: Awaited<ReturnType<typeof chatWorld>>, act: () => Promise<void>) => {
    c.set(() => fakeChild({ lines: fixture("ok"), before: act }));
    await runHop(c.deps, await c.input());
    return c.finishedChat();
  };

  test("a reply alone → replied", async () => {
    const c = await chatWorld();
    const h = await run(c, async () => { await c.reply(); });
    expect([h.outcome, h.note]).toEqual(["replied", ""]);
  });
  test("a proposal and a reply → proposed", async () => {
    const c = await chatWorld();
    const h = await run(c, async () => { await c.locate(); const p = await c.propose(); await c.reply({ proposalId: p.id, text: "1 งาน ใช้ประมาณ 2 ก้าว" }); });
    expect(h.outcome).toBe("proposed");
  });
  test("an amendment and a reply → amended", async () => {
    const c = await chatWorld();
    const h = await run(c, async () => { await c.locate("ระบบจ่ายเงินเดือน"); const a = await c.amend(); await c.reply({ amendment: { blueprintMessageId: a.id ?? "bp-msg-1" } }); });
    expect(h.outcome).toBe("amended");
  });
  test("both → proposed_and_amended", async () => {
    const c = await chatWorld();
    const h = await run(c, async () => { await c.locate(); const p = await c.propose(); const a = await c.amend(); await c.reply({ proposalId: p.id, amendment: { blueprintMessageId: a.id ?? "bp-msg-1" } }); });
    expect(h.outcome).toBe("proposed_and_amended");
  });
  test("no reply → failed, with the no-result note (even if a proposal was made — the operator got no answer)", async () => {
    const c = await chatWorld();
    const h = await run(c, async () => { await c.locate(); await c.propose(); });
    expect([h.outcome, h.note]).toEqual(["failed", `${NOTES.noResult} · tools: locate ×0, reply ×0 · turns 1`]);
  });
  test("the exit code and tokens are recorded exactly as for a card hop", async () => {
    const c = await chatWorld();
    c.set(() => fakeChild({ lines: fixture("ok"), exitCode: 2, before: async () => { await c.reply(); } }));
    await runHop(c.deps, await c.input());
    const h = await c.finishedChat();
    expect([h.outcome, h.note, h.tokensIn]).toEqual(["replied", "exit 2", 10 + 13124 + 22383]);
  });
  test("a follow-up after the worker's question pack: the runner reads the thread and the prompt carries the questions and the ORIGINAL request (TASK-C-036)", async () => {
    const c = await chatWorld();
    await run(c, async () => { await c.reply({ text: "ขอถาม", questions: [{ text: "ใช้สีไหน", proposedDefault: "ตามเดิม", cases: ["ใช่", "ไม่ใช่"] }] }); });
    const m2 = (await c.call("POST", `/v1/projects/${c.project.id}/chat`, { text: "1. ตามนั้น" })).json;
    const hop2 = await c.api.startHop(c.project.id, { messageId: m2.id, workerId: c.worker.id, claim: "inst-1" });
    c.set(() => fakeChild({ lines: fixture("ok") }));
    await runHop(c.deps, { project: (await c.input()).project, hop: hop2, worker: (await c.input()).worker });
    const prompt = c.spawned[c.spawned.length - 1]!.cmd[2]!;
    expect(prompt).toContain("answers your questions");
    expect(prompt).toContain("ใช้สีไหน");
    expect(prompt).toContain("แก้ขั้นอนุมัติห้องใหญ่"); // the operator's first message
  });
  test("a first message gets the plain prompt; a chat that cannot be read does not fail the hop", async () => {
    const c = await chatWorld();
    const plain = async () => { await run(c, async () => { await c.reply(); }); return c.spawned[c.spawned.length - 1]!.cmd[2]!; };
    expect(await plain()).not.toContain("answers your questions");
    const c2 = await chatWorld();
    c2.deps.api = { ...c2.deps.api, chatMessages: async () => { throw new Error("boom"); } };
    const h = await run(c2, async () => { await c2.reply(); });
    expect(h.outcome).toBe("replied");
    expect(c2.log.some((l) => l.includes("could not read the chat"))).toBe(true);
  });
  test("the chat hop is started with the READ-ONLY file tools and every project root added (TASK-C-041)", async () => {
    const c = await chatWorld();
    await run(c, async () => { await c.reply(); });
    const cmd = c.spawned[0]!.cmd;
    const roots = (await c.input()).project.workspace.roots;
    expect(cmd.slice(cmd.indexOf("--tools"), cmd.indexOf("--tools") + 2)).toEqual(["--tools", "Read,Glob,Grep"]);
    const at = cmd.indexOf("--add-dir");
    expect(cmd.slice(at, at + 1 + roots.length)).toEqual(["--add-dir", ...roots]);
    expect(cmd[at + 1 + roots.length]!.startsWith("--")).toBe(true);
  });
  test("a chat hop with NO roots is started with no file tool at all (--tools empty) and no --add-dir", async () => {
    const c = await chatWorld();
    c.set(() => fakeChild({ lines: fixture("ok"), before: async () => { await c.reply(); } }));
    const inp = await c.input();
    await runHop(c.deps, { ...inp, project: { ...inp.project, workspace: { roots: [] } } });
    const cmd = c.spawned[0]!.cmd;
    expect(cmd.slice(cmd.indexOf("--tools"), cmd.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(cmd).not.toContain("--add-dir");
  });
  test("the chat prompt names the folders by their D-098 names and never by a machine path", async () => {
    const c = await chatWorld();
    await run(c, async () => { await c.reply(); });
    const prompt = c.spawned[0]!.cmd[2]!;
    const roots = (await c.input()).project.workspace.roots;
    for (const r of roots) { expect(prompt).not.toContain(r); expect(prompt).toContain(r.split("/").pop()!); }
  });
  test("it runs in the hop's OWN private folder, never in the project's repo", async () => {
    const c = await chatWorld();
    c.set(() => fakeChild({ lines: fixture("ok"), before: async () => { await c.reply(); } }));
    await runHop(c.deps, await c.input());
    const { cmd, cwd } = c.spawned[0]!;
    const roots = (await c.input()).project.workspace.roots;
    expect(roots.includes(cwd)).toBe(false);
    expect(cwd).toContain(`hop-${c.chatHop.id}`);
    expect(cmd).toContain("--add-dir"); // the roots are READ through --add-dir; the cwd is not one of them
  });
  test("it works with NO workspace roots (a card hop is refused without them; the chat needs no folder)", async () => {
    const c = await chatWorld();
    c.set(() => fakeChild({ lines: fixture("ok"), before: async () => { await c.reply(); } }));
    const inp = await c.input();
    await runHop(c.deps, { ...inp, project: { ...inp.project, workspace: { roots: [] } } });
    expect((await c.finishedChat()).outcome).toBe("replied");
    expect(c.spawned).toHaveLength(1);
  });
  test("the prompt is the CHAT template: the message and the project id, chat_context first", async () => {
    const c = await chatWorld();
    c.set(() => fakeChild({ lines: fixture("ok"), before: async () => { await c.reply(); } }));
    await runHop(c.deps, await c.input());
    expect(c.spawned[0]!.cmd[2]).toContain(c.msg.id);
    expect(c.spawned[0]!.cmd[2]).toContain(c.project.id);
    expect(c.spawned[0]!.cmd[2]).toContain("chat_context");
  });
  test("a limit or a block on a chat hop ends it like any hop (no run to close)", async () => {
    const c = await chatWorld();
    c.set(() => fakeChild({ lines: limitFixture().slice(0, 14), hang: true }));
    const r = await runHop(c.deps, await c.input());
    expect([(await c.finishedChat()).outcome, r.limit?.status]).toEqual(["stopped", "rejected"]);
  });
});

describe("what claude is started with (SPEC-C-003 § 2)", () => {
  test("cwd = the first root and --add-dir for the rest; the model, effort, settings, strict MCP, no web, the skills file", async () => {
    const w = await world();
    await runHop(w.deps, await w.input());
    const { cmd, cwd } = w.spawned[0]!;
    const roots = (await w.input()).project.workspace.roots;
    expect(cwd).toBe(roots[0]!);
    expect(cmd[0]).toBe("/bin/claude");
    const at = (flag: string) => cmd.indexOf(flag);
    expect(cmd[1]).toBe("-p");
    expect(cmd[2]).toContain(w.card.id);
    expect(cmd.slice(at("--model"), at("--model") + 2)).toEqual(["--model", "haiku"]);
    expect(cmd.slice(at("--effort"), at("--effort") + 2)).toEqual(["--effort", "low"]);
    expect(cmd.slice(at("--permission-mode"), at("--permission-mode") + 2)).toEqual(["--permission-mode", "acceptEdits"]);
    expect(cmd.slice(at("--output-format"), at("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(cmd).toContain("--verbose");
    expect(cmd).toContain("--strict-mcp-config");
    expect(cmd).toContain("--no-session-persistence");
    expect(cmd[at("--settings") + 1]).toContain(`hop-${w.hop.id}/settings.json`); // every hop has its OWN settings file (TASK-C-042)
    expect(cmd.slice(at("--disallowedTools"), at("--disallowedTools") + 4)).toEqual(["--disallowedTools", "WebFetch", "WebSearch", cmd[at("--disallowedTools") + 3]!]);
    expect(cmd[at("--disallowedTools") + 3]!.startsWith("--")).toBe(true); // a variadic flag must be followed by a flag, or it swallows the next argument
    expect(cmd.slice(at("--add-dir"), at("--add-dir") + 2)).toEqual(["--add-dir", roots[1]!]);
    expect(cmd).not.toContain("--bare"); // --bare drops the subscription login (TASK-C-029)
    expect(cmd.slice(at("--setting-sources"), at("--setting-sources") + 2)).toEqual(["--setting-sources", "project"]); // R-5: the operator's ~/.claude is not loaded
    expect(cmd.indexOf("--append-system-prompt-file")).toBeGreaterThan(-1);
  });
});

describe("buildArgs / buildMcpConfig", () => {
  const worker = { id: "w", name: "N", roles: ["BE"], skills: [], model: "sonnet" as const, effort: "high" as const };
  test("a worker with no skills passes no --append-system-prompt-file", () => {
    const a = buildArgs({ prompt: "p", worker, roots: ["/r"], settingsFile: "/s", mcpFile: "/m", skillsFile: null });
    expect(a).not.toContain("--append-system-prompt-file");
    expect(a).not.toContain("--add-dir");
    expect(a.slice(0, 2)).toEqual(["-p", "p"]);
  });
  test("a CHAT hop with roots: --tools Read,Glob,Grep, --add-dir for EVERY root, and Bash / Write / Edit denied but not Read (TASK-C-041)", () => {
    const a = buildArgs({ prompt: "p", worker, roots: ["/a", "/b"], settingsFile: "/s", mcpFile: "/m", skillsFile: null, chat: true });
    const t = a.indexOf("--tools");
    expect(a.slice(t, t + 2)).toEqual(["--tools", "Read,Glob,Grep"]);
    const d = a.indexOf("--add-dir");
    expect(a.slice(d, d + 3)).toEqual(["--add-dir", "/a", "/b"]);
    expect(a[d + 3]!.startsWith("--")).toBe(true);
    const dis = a.indexOf("--disallowedTools");
    const denied = a.slice(dis + 1, a.findIndex((x, i) => i > dis && x.startsWith("--")));
    for (const tool of ["Bash", "Write", "Edit", "NotebookEdit", "Task", "WebFetch", "WebSearch"]) expect(denied).toContain(tool);
    for (const tool of ["Read", "Glob", "Grep"]) expect(denied).not.toContain(tool);
  });
  test("a card hop's args are unchanged (the exact list of today)", () => {
    expect(buildArgs({ prompt: "p", worker, roots: ["/r"], settingsFile: "/s", mcpFile: "/m", skillsFile: null })).toEqual([
      "-p", "p", "--model", "sonnet", "--effort", "high", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
      "--setting-sources", "project", "--settings", "/s", "--mcp-config", "/m", "--strict-mcp-config", "--disallowedTools", "WebFetch", "WebSearch", "--no-session-persistence",
    ]);
  });
  test("a CHAT hop with NO roots gets no built-in tool at all (--tools empty) and no --add-dir; the coding tools are denied by name (TASK-C-036 (c))", () => {
    const chat = buildArgs({ prompt: "p", worker, roots: [], settingsFile: "/s", mcpFile: "/m", skillsFile: null, chat: true });
    expect(chat).not.toContain("--add-dir");
    const card = buildArgs({ prompt: "p", worker, roots: ["/r"], settingsFile: "/s", mcpFile: "/m", skillsFile: null });
    const t = chat.indexOf("--tools");
    expect(chat.slice(t, t + 2)).toEqual(["--tools", ""]);
    expect(chat[t + 2]!.startsWith("--")).toBe(true); // variadic: followed by a flag, never by the next positional
    const d = chat.indexOf("--disallowedTools");
    const end = chat.findIndex((x, i) => i > d && x.startsWith("--")); // a variadic flag is followed by a flag, never by the next positional
    expect(end).toBeGreaterThan(d);
    const denied = chat.slice(d + 1, end);
    for (const tool of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "WebFetch", "WebSearch"]) expect(denied).toContain(tool);
    expect(card).not.toContain("--tools");
    const cd = card.indexOf("--disallowedTools");
    expect(card.slice(cd + 1, cd + 3)).toEqual(["WebFetch", "WebSearch"]);
  });
  test("the MCP config holds ONLY CAW's server, as this worker, by absolute path", () => {
    const cfg: any = buildMcpConfig("http://127.0.0.1:4530", "w-1", "hop-9");
    expect(Object.keys(cfg.mcpServers)).toEqual(["caw"]);
    const s = cfg.mcpServers.caw;
    expect(s.env).toEqual({ CAW_API_URL: "http://127.0.0.1:4530", CAW_WORKER_ID: "w-1", CAW_HOP_ID: "hop-9" }); // contract v1.5: a worker write names its running hop
    expect(s.args[0]).toBe("run");
    expect(s.args[1].startsWith("/")).toBe(true);
    expect(s.args[1].endsWith("src/mcp/server.ts")).toBe(true);
    expect(existsSync(s.args[1])).toBe(true);
  });
});

describe("a worker with two roles loads exactly its own skills[] (TASK-C-037, contract v1.10)", () => {
  mkdirSync(join(WS, ".claude/skills/role-fe"), { recursive: true });
  writeFileSync(join(WS, ".claude/skills/role-fe/SKILL.md"), "FE craft");
  /** the skills file is removed when the hop ends, so it is read at spawn time */
  async function skillsOf(skills: string[]) {
    const w = await world();
    const input = await w.input();
    let text = "";
    w.set(() => {
      const cmd = w.spawned[w.spawned.length - 1]!.cmd;
      const at = cmd.indexOf("--append-system-prompt-file");
      text = at < 0 ? "" : readFileSync(cmd[at + 1]!, "utf8");
      return fakeChild({ lines: fixture("ok") });
    });
    await runHop(w.deps, { ...input, worker: { ...input.worker, roles: ["FE", "BE"], skills } });
    return { text, prompt: w.spawned[0]!.cmd[2]! };
  }
  test("roles FE + BE with skills [role-be]: role-be only — the FE role adds no role-fe skill", async () => {
    const { text, prompt } = await skillsOf(["role-be"]);
    expect(text).toContain("# Skill: role-be");
    expect(text).not.toContain("role-fe");
    expect(text).not.toContain("FE craft");
    expect(prompt).toContain("(FE + BE)");
  });
  test("roles FE + BE with skills [role-fe, role-be]: both, in that order — none dropped", async () => {
    const { text } = await skillsOf(["role-fe", "role-be"]);
    expect(text.indexOf("# Skill: role-fe")).toBeGreaterThan(-1);
    expect(text.indexOf("# Skill: role-be")).toBeGreaterThan(text.indexOf("# Skill: role-fe"));
  });
});

describe("the per-hop trace and the tool summary (TASK-C-036)", () => {
  const toolLines = [
    JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "mcp__caw__chat_context", input: {} }] } }),
    JSON.stringify({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "mcp__caw__chat_context", input: {} }] } }),
  ];
  test("the stream is kept as <hopId>.jsonl, redacted, and its path is logged", async () => {
    const w = await world();
    const traceDir = tmp("caw-trace-");
    w.set(() => fakeChild({ lines: [...fixture("ok"), '{"x":"https://u:hunter2@host/r"}'], before: async () => { await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "done" }, w.actor); } }));
    await runHop({ ...w.deps, traceDir }, await w.input());
    const text = readFileSync(join(traceDir, `${w.hop.id}.jsonl`), "utf8");
    expect(text).toContain('"type":"system"');
    expect(text).not.toContain("hunter2");
    expect(w.log.some((l) => l.includes(`trace ${join(traceDir, `${w.hop.id}.jsonl`)}`))).toBe(true);
  });
  test("a hop that is stopped (killed on a block) still leaves its trace", async () => {
    const w = await world();
    const traceDir = tmp("caw-trace-");
    w.set(() => fakeChild({ lines: fixture("push-absolute-hooks").slice(0, -1), hang: true }));
    await runHop({ ...w.deps, traceDir }, await w.input());
    expect((await w.finished()).outcome).toBe("stopped");
    expect(existsSync(join(traceDir, `${w.hop.id}.jsonl`))).toBe(true);
  });
  test("no traceDir, no trace", async () => {
    const w = await world();
    await runHop(w.deps, await w.input());
    expect(w.log.some((l) => l.includes(" trace "))).toBe(false);
  });
  test("a failed card hop's note carries the tool summary after the existing note", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: [...toolLines, ...fixture("ok")] }));
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(h.outcome).toBe("failed");
    expect(h.note).toBe(`${NOTES.noResult} · tools: chat_context ×2 · turns 3`);
  });
  test("a successful hop's note stays empty — the summary is for failed and stopped only", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: [...toolLines, ...fixture("ok")], before: async () => { await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "d" }, w.actor); } }));
    await runHop(w.deps, await w.input());
    expect((await w.finished()).note).toBe("");
  });
});

describe("the hop heartbeat (TASK-C-038, contract v1.11, D-066)", () => {
  /** A fake child whose stdout lines the test pushes one at a time, with the fake clock set before each */
  function scripted() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let done!: (code: number) => void;
    const exited = new Promise<number>((r) => { done = r; });
    const enc = new TextEncoder();
    const child: Child = {
      pid: undefined, exited, kill: () => { try { controller.close(); } catch { /* closed */ } done(143); }, stderrText: async () => "",
      stdout: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }),
    };
    return { child, push: async (line: string) => { controller.enqueue(enc.encode(`${line}\n`)); await new Promise((r) => setTimeout(r, 5)); }, end: () => { try { controller.close(); } catch { /* closed */ } done(0); } };
  }
  const line = JSON.stringify({ type: "system", subtype: "status" });
  async function setupHb(heartbeat: (hopId: string) => Promise<{ lastActivityAt: string }>) {
    const w = await world();
    let t = 0; // seconds on the fake clock
    const calls: number[] = [];
    w.deps.now = () => new Date(t * 1000);
    w.deps.api = { ...w.deps.api, heartbeat: async (id: string) => { calls.push(t); return heartbeat(id); } };
    const s = scripted();
    w.set(() => s.child);
    const running = (async () => runHop(w.deps, await w.input()))();
    await new Promise((r) => setTimeout(r, 30)); // the child is spawned
    const at = async (sec: number) => { t = sec; await s.push(line); };
    return { w, s, at, calls, running };
  }
  const ok = async () => ({ lastActivityAt: "2026-10-14T00:00:00.000Z" });

  test("lines at t = 0, 10, 31, 45, 62 s → heartbeats at 31 and 62 only (30 s since the last one SENT; the first is due 30 s after the spawn)", async () => {
    const h = await setupHb(ok);
    for (const sec of [0, 10, 31, 45, 62]) await h.at(sec);
    h.s.end(); await h.running;
    expect(h.calls).toEqual([31, 62]);
  });
  test("one line at t = 0, a 5-minute silence, then a line → exactly one heartbeat, on the late line (no timer)", async () => {
    const h = await setupHb(ok);
    await h.at(0); await h.at(300);
    h.s.end(); await h.running;
    expect(h.calls).toEqual([300]);
  });
  test("a heartbeat that rejects: the hop still ends with its normal outcome and the log says `heartbeat failed`", async () => {
    const h = await setupHb(async () => { throw new Error("network down"); });
    await h.at(31);
    await h.w.call("POST", `/v1/cards/${h.w.card.id}/comments`, { text: "done" }, h.w.actor);
    h.s.end(); await h.running;
    expect((await h.w.finished()).outcome).toBe("commented");
    expect(h.w.log.some((l) => l.includes(`hop ${h.w.hop.id}: heartbeat failed: network down`))).toBe(true);
  });
  test("a 409 hop_not_running: no further heartbeat for this hop", async () => {
    const h = await setupHb(async () => { throw new RunnerApiError(409, "hop_not_running", "the hop is not running"); });
    await h.at(31); await h.at(70); await h.at(120);
    h.s.end(); await h.running;
    expect(h.calls).toEqual([31]);
    expect(h.w.log.some((l) => l.includes("heartbeat failed: hop_not_running"))).toBe(true);
  });
  test("a slow heartbeat (still pending) while lines keep coming: no second call until it settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = await setupHb(async () => { await gate; return { lastActivityAt: "x" }; });
    await h.at(31); await h.at(70); await h.at(120);
    expect(h.calls).toEqual([31]);
    release(); await new Promise((r) => setTimeout(r, 10));
    await h.at(150);
    h.s.end(); await h.running;
    expect(h.calls).toEqual([31, 150]);
  });
  test("none after the stream has stopped: the hook-block line ends the reading, the child is killed, and no heartbeat follows it", async () => {
    const h = await setupHb(ok);
    await h.at(31);                                                      // one heartbeat
    for (const l of fixture("push-absolute-hooks").slice(0, 15)) { try { await h.s.push(l); } catch { break; } } // reaches the block → the stream is stopped
    await h.running;
    expect((await h.w.finished()).outcome).toBe("stopped");
    expect(h.calls).toEqual([31]);
  });
  test("through the REAL in-process API (A-085): lines spread over 95 s of fake time → every heartbeat answers 200, none fails, and Hop.lastActivityAt is not before startedAt", async () => {
    const results: { lastActivityAt: string }[] = [];
    const h: Awaited<ReturnType<typeof setupHb>> = await setupHb(async (id) => { const r = await h.w.api.heartbeat(id); results.push(r); return r; });
    for (const sec of [0, 31, 62, 95]) await h.at(sec);
    h.s.end(); await h.running;
    expect(h.calls).toEqual([31, 62, 95]);               // the runner's clock: 30 s apart
    expect(results).toHaveLength(3);                       // all three answered 200 (the api client throws on any other status)
    expect(h.w.log.some((l) => l.includes("heartbeat failed"))).toBe(false);
    const hop = await h.w.finished();
    expect(hop.lastActivityAt).toBeDefined();
    expect(Date.parse(hop.lastActivityAt!)).toBeGreaterThanOrEqual(Date.parse(hop.startedAt));
    for (const r of results) expect(Date.parse(r.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse(hop.startedAt)); // the core stamps the time: the runner sent none
  });
});

describe("read-only folders for a card hop (TASK-C-042 Part B, D-100, REQ-015 R4a / AC-3c)", () => {
  const withRo = async (ro: (roots: string[]) => string[] | undefined, roots?: (r: string[]) => string[]) => {
    const w = await world();
    const baseFile = join(tmp("caw-hop-base-"), "settings.json"); // the runner's base settings, which a read-only hop extends
    writeFileSync(baseFile, JSON.stringify({ permissions: { allow: [], deny: [] }, sandbox: { enabled: true } }));
    w.deps.settingsFile = baseFile;
    const inp = await w.input();
    const all = roots ? roots(inp.project.workspace.roots) : inp.project.workspace.roots;
    const workspace: any = { roots: all };
    const r = ro(all);
    if (r !== undefined) workspace.readOnly = r;
    await runHop(w.deps, { ...inp, project: { ...inp.project, workspace } });
    return { w, all, cmd: w.spawned[0]?.cmd, cwd: w.spawned[0]?.cwd };
  };
  const settingsOf = (cmd: string[]) => JSON.parse(readFileSync(cmd[cmd.indexOf("--settings") + 1]!, "utf8"));

  test("cwd = the first WRITABLE root, every other root (both kinds) is added, and the read-only one is denied Edit / Write twice (permission + sandbox)", async () => {
    const { all, cmd, cwd, w } = await withRo((r) => [r[0]!]);
    expect(cwd).toBe(all[1]!);
    const at = cmd!.indexOf("--add-dir");
    expect(cmd!.slice(at, at + 2)).toEqual(["--add-dir", all[0]!]);
    expect(cmd![cmd!.indexOf("--settings") + 1]).not.toBe(w.deps.settingsFile); // the hop's OWN settings file
  });
  test("the per-hop settings file is the base plus the denies, for exactly the read-only roots", async () => {
    const w = await world();
    const inp = await w.input();
    const [a, b] = inp.project.workspace.roots;
    const base = { permissions: { allow: ["x"], deny: ["Bash(curl *)"] }, sandbox: { enabled: true } };
    const baseFile = join(tmp("caw-hop-base-"), "settings.json");
    writeFileSync(baseFile, JSON.stringify(base));
    w.deps.settingsFile = baseFile;
    let seen: any = null;
    w.set(() => { const cmd = w.spawned[w.spawned.length - 1]!.cmd; seen = settingsOf(cmd); return fakeChild({ lines: fixture("ok") }); });
    await runHop(w.deps, { ...inp, project: { ...inp.project, workspace: { roots: [a!, b!], readOnly: [a!] } } as any });
    expect(seen.permissions.allow).toEqual(["x"]);
    expect(seen.permissions.deny).toEqual(["Bash(curl *)", `Edit(/${a}/**)`, `Write(/${a}/**)`]);
    expect(seen.sandbox.filesystem.denyWrite).toEqual([a]);
    expect(seen.permissions.deny.join(" ")).not.toContain(b!);
  });
  test("the roots in the other order: still cwd = the first writable one", async () => {
    const { all, cwd } = await withRo((r) => [r[1]!], undefined);
    expect(cwd).toBe(all[0]!);
  });
  test("no read-only roots: no Edit / Write deny and no denyWrite in the hop's settings", async () => {
    const w = await world();
    let seen: any = null;
    w.set(() => { seen = settingsOf(w.spawned[w.spawned.length - 1]!.cmd); return fakeChild({ lines: fixture("ok") }); });
    await runHop(w.deps, await w.input());
    expect(seen.permissions.deny.filter((d: string) => d.startsWith("Edit(") || d.startsWith("Write("))).toEqual([]);
    expect(seen.sandbox.filesystem.denyWrite).toBeUndefined();
  });
  test("a project without `readOnly` (a core before A-094) is read as []", async () => {
    const w = await world();
    const inp = await w.input();
    let seen: any = null;
    w.set(() => { seen = settingsOf(w.spawned[w.spawned.length - 1]!.cmd); return fakeChild({ lines: fixture("ok") }); });
    await runHop(w.deps, { ...inp, project: { ...inp.project, workspace: { roots: inp.project.workspace.roots } } });
    expect(w.spawned[0]!.cwd).toBe(inp.project.workspace.roots[0]!);
    expect(seen.sandbox.filesystem.denyWrite).toBeUndefined();
  });
  test("every root read-only: nowhere to work — stopped with today's noRoots note, claude not spawned", async () => {
    const { w } = await withRo((r) => [...r]);
    expect(w.spawned).toHaveLength(0);
    const h = await w.finished();
    expect([h.outcome, h.note]).toEqual(["stopped", NOTES.noRoots]);
  });
  test("a CHAT hop is unchanged by read-only roots: its private cwd, every root added, no write denies (it writes nothing anyway)", async () => {
    const w = await world();
    await w.api.finishHop(w.hop.id, { outcome: "commented" });
    await w.call("PUT", `/v1/projects/${w.project.id}/chain/entry`, { workerId: w.worker.id });
    const msg = (await w.call("POST", `/v1/projects/${w.project.id}/chat`, { text: "x" })).json;
    const chatHop = await w.api.startHop(w.project.id, { messageId: msg.id, workerId: w.worker.id, claim: "inst-1" });
    const inp = await w.input();
    await runHop(w.deps, { project: { ...inp.project, workspace: { roots: inp.project.workspace.roots, readOnly: [inp.project.workspace.roots[0]!] } } as any, hop: chatHop, worker: inp.worker });
    const { cmd, cwd } = w.spawned[0]!;
    expect(cwd).toContain(`hop-${chatHop.id}`);
    expect(cmd[cmd.indexOf("--settings") + 1]).toContain(`hop-${chatHop.id}/settings.json`);
    const at = cmd.indexOf("--add-dir");
    expect(cmd.slice(at, at + 3)).toEqual(["--add-dir", ...inp.project.workspace.roots]);
  });
});

describe("the read fence of every hop (TASK-C-042 Part A, UP-3: client data must never reach the model)", () => {
  const settingsOf = (cmd: string[]) => JSON.parse(readFileSync(cmd[cmd.indexOf("--settings") + 1]!, "utf8"));
  /** the settings file is removed with the hop folder, so it is read at spawn time */
  async function fence(chat: boolean) {
    const w = await world();
    const inp = await w.input();
    let seen: any = null;
    let hopDir = "";
    w.set(() => { const s = w.spawned[w.spawned.length - 1]!; seen = settingsOf(s.cmd); hopDir = s.cmd[s.cmd.indexOf("--mcp-config") + 1]!.replace(/\/mcp\.json$/, ""); return fakeChild({ lines: fixture("ok") }); });
    if (!chat) await runHop(w.deps, inp);
    else {
      await w.api.finishHop(w.hop.id, { outcome: "commented" });
      await w.call("PUT", `/v1/projects/${w.project.id}/chain/entry`, { workerId: w.worker.id });
      const msg = (await w.call("POST", `/v1/projects/${w.project.id}/chat`, { text: "x" })).json;
      const chatHop = await w.api.startHop(w.project.id, { messageId: msg.id, workerId: w.worker.id, claim: "inst-1" });
      await runHop(w.deps, { project: inp.project, hop: chatHop, worker: inp.worker });
    }
    return { seen, roots: inp.project.workspace.roots, hopDir };
  }
  for (const chat of [false, true]) {
    test(`a ${chat ? "CHAT" : "CARD"} hop: ~/ denied for Bash reads, the roots and its own folder re-allowed, the file-tool guard hook with the same folders, and no blockReads key`, async () => {
      const { seen, roots, hopDir } = await fence(chat);
      expect(seen.sandbox.filesystem.denyRead).toEqual(["~/"]);
      for (const d of [...roots, hopDir]) expect(seen.sandbox.filesystem.allowRead).toContain(d);
      const hook = seen.hooks.PreToolUse.find((h: any) => h.matcher === "Read|Glob|Grep");
      expect(hook).toBeDefined();
      const args = JSON.parse(hook.hooks[0].command.slice(hook.hooks[0].command.indexOf("'[") + 1, -1));
      for (const d of [...roots, hopDir]) expect(args).toContain(d);
      expect(seen.permissions.blockReadsOutsideWorkingDirectories).toBeUndefined();
      expect(seen.sandbox.enabled).toBe(true); // the sandbox stays on
    });
  }
  test("a base file that cannot be read: the hop FAILS (it never runs on settings it could not read, so never unfenced) and claude is not started", async () => {
    const w = await world();
    w.deps.settingsFile = join(tmp("caw-hop-nobase-"), "missing.json");
    await runHop(w.deps, await w.input());
    expect(w.spawned).toHaveLength(0);
    expect((await w.finished()).outcome).toBe("failed");
  });
});

describe("read-guard refusals are SOFT, counted, and the 3rd stops the hop (TASK-C-042 Q2, Sector 2026-10-20)", () => {
  /** the recorded pair from the real run (fixtures/read-guard.stream.jsonl: a Read of a home canary and the hook's refusal), with a fresh tool_use id each time */
  const refusal = (n: number): string[] => fixture("read-guard").map((l) => l.split("toolu_01WS8m3xoZw3QUN4sHqrfiwB").join(`toolu_refused_${n}`));
  const refusals = (k: number) => Array.from({ length: k }, (_, i) => refusal(i)).flat();
  const WORDS = (n: number) => `อ่านนอกโฟลเดอร์ถูกปฏิเสธ ${n} ครั้ง`;
  const comment = (w: Awaited<ReturnType<typeof world>>) => async () => { await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "done" }, w.actor); };

  test("the recorded line is a hook block that names read-guard (the fixture is what the real claude printed)", () => {
    expect(fixture("read-guard").join("\n")).toContain("PreToolUse:Read hook error");
    expect(fixture("read-guard").join("\n")).toContain("read-guard");
  });
  test("1 refusal: the hop goes on and ends normally, with the count in its note; the child is not killed", async () => {
    const w = await world();
    let child!: ReturnType<typeof fakeChild>;
    w.set(() => (child = fakeChild({ lines: [...refusals(1), ...fixture("ok")], before: comment(w) }))); // built when claude is spawned: its comment must come after the hop's start
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect([h.outcome, h.note]).toEqual(["commented", WORDS(1)]);
    expect(child.killed).toBe(false);
    expect(w.log.some((l) => l.includes("read-guard") && l.includes("refused"))).toBe(true);
  });
  test("2 refusals: still goes on, note says 2", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: [...refusals(2), ...fixture("ok")], before: comment(w) }));
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect([h.outcome, h.note]).toEqual(["commented", WORDS(2)]);
  });
  test("the 3rd refusal in one hop stops it with today's blocked note, naming what the worker tried", async () => {
    const w = await world();
    const child = fakeChild({ lines: [...refusals(3), ...fixture("ok")], hang: true });
    w.set(() => child);
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(h.outcome).toBe("stopped");
    expect(h.note.startsWith("หยุดไว้: Blew พยายาม Read")).toBe(true);
    expect(child.killed).toBe(true);
  });
  test("a git-push block still stops at once, even after a soft read-guard refusal (unchanged)", async () => {
    const w = await world();
    const child = fakeChild({ lines: [...refusals(1), ...fixture("push-absolute-hooks").slice(0, 15)], hang: true });
    w.set(() => child);
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(h.outcome).toBe("stopped");
    expect(h.note).toContain("git push");
    expect(child.killed).toBe(true);
  });
  test("a hop that FAILS after soft refusals carries both: the refusal count and the tool summary", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: [...refusals(1), ...fixture("ok")] }));
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(h.outcome).toBe("failed");
    expect(h.note).toContain(NOTES.noResult);
    expect(h.note).toContain(WORDS(1));
    expect(h.note).toContain("tools:");
  });
  test("no refusal, no words in the note", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: fixture("ok"), before: comment(w) }));
    await runHop(w.deps, await w.input());
    expect((await w.finished()).note).toBe("");
  });
});
