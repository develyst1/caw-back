// runHop against the REAL app on PGlite (test/helpers, imported not edited) and a FAKE `claude` child (a stream of recorded lines).
// What the fake child does through MCP in a real hop (comment, hand_off …) the test does through the API as that worker.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainOf3, newCard, setup } from "../../test/helpers/api";
import { RunnerApiError, createApi } from "./api";
import { HOOKS } from "./config";
import { type Child, type HopDeps, NOTES, buildArgs, buildMcpConfig, childEnv, folderOutsideWorkspace, refusalOf, refusedNote, runHop } from "./hop";
import { WorkerPool } from "./pool";
import { type Procs, readHopFile } from "./procs";
import { fakeChild, fixture, hopAware, limitFixture } from "./testkit";
import { formatReset } from "./thai";

const made: string[] = []; // every temp folder a test makes, removed in afterAll
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const WS = tmp("caw-hop-ws-");
const inWs = (prefix: string) => mkdtempSync(join(WS, prefix)); // removed with WS in afterAll

// ---- refusals as claude prints them (SPEC-108 D3/D4): a Bash tool_use, then an is_error tool_result with the hook's text; or a `permission_denied` system line ----
const toolUse = (id: string, name: string, input: object) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
/** a hook refusal: `hook` is the script that printed it (our read-guard.ts, or a workspace guard such as block-irreversible.sh) */
const hookRefusal = (n: number, command: string, stderr: string, hook = "read-guard.ts"): string[] => [
  toolUse(`toolu_r${n}`, "Bash", { command }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `toolu_r${n}`, is_error: true, content: `PreToolUse:Bash hook error: [/x/${hook} '["/r"]']: ${stderr}` }] } }),
];
const gitWrite = (n: number) => hookRefusal(n, "git commit -m x", 'caw-refused git_write: "commit" is not allowed — a worker reads git (status, log, diff, show, ls-files, blame, rev-parse) and never writes it');
const notAllowed = (n: number, prog = "docker") => hookRefusal(n, `${prog} ps`, `caw-refused not_allowed: "${prog}" is not a command a worker may run here — use bun, node, git (read) or file commands`);
const networkRefusal = (n: number, url = "https://example.com") => hookRefusal(n, `curl ${url}`, `caw-refused network: "${url}" reaches the network — only 127.0.0.1, localhost and [::1] are allowed`);
const outsideRefusal = (n: number, path = "/etc/hosts") => hookRefusal(n, `cat ${path}`, `caw-refused outside: "${path}" is outside the project's folders — a worker reads only inside them`);
const guardRefusal = (n: number) => hookRefusal(n, "git push origin HEAD", "Blocked by the overnight guard (git push)", "block-irreversible.sh");
const permissionDeny = (n: number, tool = "WebFetch") => [
  toolUse(`toolu_p${n}`, tool, { url: "https://example.com" }),
  JSON.stringify({ type: "system", subtype: "permission_denied", tool_name: tool, tool_use_id: `toolu_p${n}`, message: "Claude requested permissions to use a tool, but you haven't granted it yet." }),
];
/** ten distinct refusals: the cap */
const tenRefusals = (): string[] => [gitWrite(0), notAllowed(1), networkRefusal(2), outsideRefusal(3), guardRefusal(4), permissionDeny(5), notAllowed(6, "make"), outsideRefusal(7, "/etc/passwd"), networkRefusal(8, "https://a.test"), gitWrite(9)].flat();
const SENTENCE = (reason: string) => `คำสั่งนี้ทำไม่ได้: ${reason} — ทำต่อด้วยวิธีอื่น`;
/** what the worker does through MCP in a real hop: one comment on its card */
const commentBy = (w: { call: (m: string, p: string, b?: unknown, a?: string | null) => Promise<any>; card: { id: string }; actor: string }) => async () => { await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "done" }, w.actor); };
mkdirSync(join(WS, ".claude/skills/role-be"), { recursive: true });
writeFileSync(join(WS, ".claude/skills/role-be/SKILL.md"), "BE craft");

/** the runner's base settings file, which every hop extends with its own read fence (TASK-C-042) */
const baseSettings = join(tmp("caw-hop-base-"), "settings.json");
writeFileSync(baseSettings, JSON.stringify({ permissions: { allow: [], deny: [] }, hooks: { PreToolUse: [] } })); // like buildSettings now: no `sandbox` key (TASK-112)

async function world(over: { roots?: string[]; skills?: string[]; hopMaxMs?: number } = {}) {
  const t0 = await setup();
  const t = { ...t0, call: hopAware(t0.call) }; // a worker's write names its running hop (contract v1.5)
  const { project, a } = await chainOf3(t.call);
  const worker = (await t.call("POST", "/v1/workers", { name: "Blew", role: "BE", skills: over.skills ?? ["role-be"], model: "haiku", effort: "low" })).json;
  await t.call("POST", `/v1/projects/${project.id}/chain/members`, { workerId: worker.id });
  const rootA = inWs("caw-hop-root-"); // project folders are under CAW_WORKSPACE_ROOT (= WS): hop.ts refuses any other (TASK-112)
  const rootB = inWs("caw-hop-root-");
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
      await w.call("PATCH", `/v1/cards/${w.card.id}/status`, { status: "review", done: "ทำแล้ว", howToTry: "เปิดดูได้เลย" }, w.actor);
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

  // was: "a hook block in the stream ends the child at once and the hop is stopped with the worker and the action" (TASK-118 / SPEC-108 D4: no refusal ends a hop)
  test("a hook block in the stream does NOT end the hop: the recorded git push block, then the worker's comment → commented, the note says why in the PM's sentence, the child is not killed", async () => {
    const w = await world();
    let child!: ReturnType<typeof fakeChild>;
    w.set(() => (child = fakeChild({ lines: fixture("push-absolute-hooks"), before: commentBy(w) })));
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(child.killed).toBe(false);
    expect([h.outcome, h.note]).toEqual(["commented", SENTENCE("กฎความปลอดภัยกันไว้")]); // a workspace guard hook (no caw-refused prefix) → `guard`
    // the runner's log says WHAT was refused, once, with its count
    expect(w.log.filter((l) => l.includes("refused 1 of 10") && l.includes("guard"))).toHaveLength(1);
  });

  // was: "a permission denial ends it the same way"
  test("a permission denial does not end it either: recorded as `tool`, the note names the tool", async () => {
    const w = await world();
    let child!: ReturnType<typeof fakeChild>;
    w.set(() => (child = fakeChild({ lines: fixture("write-outside"), before: commentBy(w) })));
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(child.killed).toBe(false);
    expect(h.outcome).toBe("commented");
    expect(h.note).toContain(SENTENCE("เครื่องมือ Bash ใช้ในก้าวนี้ไม่ได้"));
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
  // was: a block-irreversible hook line carrying the command, hang → stopped, note "git push https://***@… token=***". Now the secret can only reach the note through the refusal's DETAIL
  // (the program / path / URL the hook quoted), and the hop is not stopped by it — so the stream ends without a result and the hop FAILS with the refusal sentence in its note.
  test("a refusal whose detail carries a secret: the stored note and the log show it redacted", async () => {
    const w = await world();
    const secretUrl = "https://bob:s3cret@example.invalid/r.git?token=abc999";
    w.set(() => fakeChild({ lines: notAllowed(1, secretUrl) }));
    await runHop(w.deps, await w.input());
    const h = await w.finished();
    expect(h.outcome).toBe("failed");
    for (const text of [h.note, w.log.join("\n")]) { expect(text).not.toContain("s3cret"); expect(text).not.toContain("abc999"); }
    expect(h.note).toContain("https://***@example.invalid/r.git?token=*** ไม่ใช่คำสั่งที่ worker ใช้ได้");
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
    w.set(() => fakeChild({ pid: 4321, lines: tenRefusals(), hang: true })); // was: one git-push hook block stopped it; now it takes the 10th refusal (SPEC-108 D4)
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
  // REQ-122 (SPEC-120 Q1): chat hops stay one-shot even when the runner has a pool — `claude -p <prompt>`, stdin closed, nothing opened
  test("REQ-122: with a pool in the deps a CHAT hop still spawns `-p <prompt>` with stdin ignored, and opens no worker", async () => {
    const c = await chatWorld();
    c.deps.pool = new WorkerPool({ tmpRoot: c.tmpRoot, log: () => {}, procs: { inspect: () => null, groupAlive: () => false, killGroup: () => {}, sleep: async () => {} }, killGraceMs: 10 });
    const stdins: (string | undefined)[] = [];
    const real = c.deps.spawn;
    c.deps.spawn = (cmd, opts) => { stdins.push(opts.stdin); return real(cmd, opts); };
    await run(c, async () => { await c.reply(); });
    const cmd = c.spawned[0]!.cmd;
    expect(cmd[1]).toBe("-p");
    expect(cmd[2]).toContain(c.msg.id); // the prompt is argv, as before
    expect(cmd).not.toContain("--input-format");
    expect(stdins).toEqual([undefined]);
    expect(c.deps.pool.sessions()).toEqual([]);
  });
  // REQ-118 (SPEC-117 D2.2, AC-2): the chat hop's system-prompt file carries every requirement of the spec. The hop's folder goes when the hop ends, so the file is read WHILE the stub child runs.
  const REQ = (n: number) => ({ key: `REQ-00${n}`, kind: "requirement", title: `ข้อกำหนด ${n}`, body: { text: `ระบบต้องทำข้อ ${n}\nบรรทัดสอง ${n}` }, origin: { date: "2026-10-30", stamp: "operator" } });
  // `noSkills`: the API never makes a worker without skills (min 1), so that case hands runHop a worker with `skills: []` directly
  const systemFileSeenBy = async (c: Awaited<ReturnType<typeof chatWorld>>, noSkills = false): Promise<string | null> => {
    let seen: string | null = null;
    c.set(() => fakeChild({ lines: fixture("ok"), before: async () => {
      const cmd = c.spawned[0]!.cmd;
      const at = cmd.indexOf("--append-system-prompt-file");
      seen = at === -1 ? null : readFileSync(cmd[at + 1]!, "utf8");
      await c.reply();
    } }));
    const input = await c.input();
    await runHop(c.deps, noSkills ? { ...input, worker: { ...input.worker, skills: [] } } : input);
    return seen;
  };
  test("AC-2: 8 requirements in the fake spec → the system-prompt file the stub received holds all 8 texts verbatim, after the worker's skills", async () => {
    const c = await chatWorld();
    c.fake.mode.snapshot = { parts: [1, 2, 3, 4, 5, 6, 7, 8].map(REQ).reverse(), links: [] };
    c.fake.mode.spec.revision = 5;
    const file = (await systemFileSeenBy(c))!;
    expect(file).toContain("BE craft"); // the worker's own skill is still there
    expect(file).toContain("# The spec's requirements (Blueprint revision 5) — they bind the whole project");
    for (let n = 1; n <= 8; n++) expect(file).toContain(`## REQ-00${n} — ข้อกำหนด ${n}\nระบบต้องทำข้อ ${n}\nบรรทัดสอง ${n}`);
    expect(file.indexOf("BE craft")).toBeLessThan(file.indexOf("# The spec's requirements"));
    expect(file.indexOf("REQ-001")).toBeLessThan(file.indexOf("REQ-008")); // by key
    expect(c.spawned[0]!.cmd[2]).not.toContain("ระบบต้องทำข้อ 1"); // not in argv
  });
  test("a worker with NO skills still gets the file, with the block alone", async () => {
    const c = await chatWorld();
    c.fake.mode.snapshot = { parts: [REQ(1)], links: [] };
    const file = (await systemFileSeenBy(c, true))!;
    expect(file.startsWith("# The spec's requirements (Blueprint revision 1)")).toBe(true);
    expect(file).toContain("ระบบต้องทำข้อ 1");
  });
  test("no requirement in the spec → no block (a worker with no skills then gets no file at all)", async () => {
    const c = await chatWorld();
    expect(await systemFileSeenBy(c, true)).toBeNull();
  });
  test("the requirements cannot be read → the one-line notice, ONE log line, and the hop goes on", async () => {
    const c = await chatWorld();
    c.deps.api = { ...c.deps.api, requirements: async () => { throw new RunnerApiError(502, "blueprint_unreachable", "Blueprint did not answer"); } };
    const file = (await systemFileSeenBy(c))!;
    expect(file).toContain("# The spec's requirements could not be read just now (Blueprint did not answer).");
    expect(c.log.filter((l) => l.includes("requirements could not be read"))).toHaveLength(1);
    expect((await c.finishedChat()).outcome).toBe("replied");
  });
  test("a CARD hop gets no requirements block (its card_context carries spec.requirements)", async () => {
    const c = await world();
    c.fake.mode.snapshot = { parts: [REQ(1)], links: [] };
    let seen = "";
    c.set(() => fakeChild({ lines: fixture("ok"), before: async () => {
      const cmd = c.spawned[0]!.cmd;
      seen = readFileSync(cmd[cmd.indexOf("--append-system-prompt-file") + 1]!, "utf8");
      await c.call("POST", `/v1/cards/${c.card.id}/comments`, { text: "done" }, c.actor);
    } }));
    await runHop(c.deps, await c.input());
    expect(seen).toContain("BE craft");
    expect(seen).not.toContain("The spec's requirements");
  });
  // REQ-121 (SPEC-119 D2, AC-2): a card hop's prompt tells the worker to do only its own card and names the other open work cards with their holders
  test("REQ-121 AC-2: a card hop's prompt holds rule 2, rule 7 and the other-cards line — the open work card with its holder; not the own card, not the done one, not the question", async () => {
    const c = await world(); // card #1 (own), #2 `another card` (todo, Blew)
    const done = (await newCard(c.call, c.project.id, { title: "already done", assigneeId: c.worker.id })).json;
    await c.call("PATCH", `/v1/cards/${done.id}/status`, { status: "done" });
    await c.call("POST", `/v1/cards/${c.card.id}/question`, { text: "ใช้สีไหน?", proposedDefault: "น้ำเงิน", cases: ["น้ำเงิน"] }, c.actor); // a question card of the project
    c.set(() => fakeChild({ lines: fixture("ok"), before: async () => { await c.call("POST", `/v1/cards/${c.card.id}/comments`, { text: "done" }, c.actor); } }));
    await runHop(c.deps, await c.input());
    const prompt = c.spawned[0]!.cmd[2]!;
    expect(prompt).toContain("2. Do only your card's work — its title and its `todo`.");
    expect(prompt).toContain("7. If you find work that no card holds, say so in a `comment` (what is missing and why) — do not build it yourself.");
    expect(prompt).toContain("Other cards hold their own work — leave it to them, even if you could do it now: #2 another card (Blew BE, todo).");
    expect(prompt).not.toContain("already done"); // done: nothing to leave
    expect(prompt).not.toContain("ใช้สีไหน?"); // a question is not work
    expect(prompt).not.toContain(`#${1} `); // the own card is not listed (its number only appears in the "Your card is" line)
  });
  test("REQ-121: a cards read that throws → the hop still runs, no other-cards line, and the log says why", async () => {
    const c = await world();
    c.deps.api = { ...c.deps.api, cards: async () => { throw new RunnerApiError(500, "boom", "cards down"); } };
    c.set(() => fakeChild({ lines: fixture("ok"), before: async () => { await c.call("POST", `/v1/cards/${c.card.id}/comments`, { text: "done" }, c.actor); } }));
    await runHop(c.deps, await c.input());
    expect(c.spawned).toHaveLength(1);
    expect(c.spawned[0]!.cmd[2]).not.toContain("Other cards hold their own work");
    expect(c.log.filter((l) => l.includes("the cards could not be read for the other-cards line"))).toHaveLength(1);
    expect((await c.finished()).outcome).toBe("commented");
  });
  test("a limit or a block on a chat hop ends it like any hop (no run to close)", async () => {
    const c = await chatWorld();
    c.set(() => fakeChild({ lines: limitFixture().slice(0, 14), hang: true }));
    const r = await runHop(c.deps, await c.input());
    expect([(await c.finishedChat()).outcome, r.limit?.status]).toEqual(["stopped", "rejected"]);
  });
});

// REQ-122 (SPEC-120 D1/D3/D4): with a pool, a card hop is one TASK on its worker's open process — a stream-json user message on stdin, over at the `result` line
describe("an open worker: a card hop is a task on its worker's open process (REQ-122)", () => {
  type Task = { n: number; prompt: string; hopFileId: string };
  type Script = (t: Task) => Promise<"die" | void>;
  /** a scripted open `claude`: its stdout stays open across tasks; every stdin line runs `onTask` (the worker's MCP calls, as API calls), then the recorded `ok` stream — ending in a `result` — is printed */
  function openStub(cmd: string[], onTask: Script, streamOf: (n: number) => string[] = () => fixture("ok")) {
    const enc = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let done!: (code: number) => void;
    const exited = new Promise<number>((r) => { done = r; });
    const close = (code: number) => { try { ctrl.close(); } catch { /* already closed */ } done(code); };
    const mcp = JSON.parse(readFileSync(cmd[cmd.indexOf("--mcp-config") + 1]!, "utf8")).mcpServers.caw.env as { CAW_HOP_FILE?: string; CAW_HOP_ID?: string };
    const written: string[] = [];
    const child = {
      killed: false, ended: false, written, mcp, exited,
      stdout: new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } }),
      stdin: {
        write(line: string) {
          written.push(line);
          const n = written.length;
          void (async () => {
            const hopFileId = readFileSync(mcp.CAW_HOP_FILE!, "utf8").trim(); // the hop id on THIS task, as the real MCP server reads it
            if ((await onTask({ n, prompt: JSON.parse(line).message.content, hopFileId })) === "die") { close(1); return; }
            try { for (const l of streamOf(n)) ctrl.enqueue(enc.encode(`${l}\n`)); } catch { /* the process was ended meanwhile */ }
          })();
        },
        end() { child.ended = true; close(0); },
      },
      kill(sig = "SIGTERM") { child.killed = true; close(sig === "SIGKILL" ? 137 : 143); },
      stderrText: async () => "",
    };
    return child;
  }

  const noProcs: Procs = { inspect: () => null, groupAlive: () => false, killGroup: () => {}, sleep: async () => {} };

  async function openWorld(over: { hopMaxMs?: number } = {}) {
    const w = await world(over);
    const pool = new WorkerPool({ tmpRoot: w.tmpRoot, log: (l) => w.log.push(l), procs: noProcs, killGraceMs: 10 });
    w.deps.pool = pool;
    const stubs: ReturnType<typeof openStub>[] = [];
    const stdins: (string | undefined)[] = [];
    const seen: string[] = []; // the hop id in the worker's hop file at each task
    const cardOf = (prompt: string) => /Your card is (\S+)/.exec(prompt)![1]!;
    // by default a task is what a worker does: one comment on its card, naming the hop it read from the file (as the MCP server does)
    let script: Script = async (t) => { seen.push(t.hopFileId); await w.call("POST", `/v1/cards/${cardOf(t.prompt)}/comments`, { text: "done" }, w.actor, { "x-caw-hop": t.hopFileId }); };
    let streamOf: (n: number) => string[] = () => fixture("ok"); // what each task prints (default: the recorded `ok` run)
    w.deps.spawn = (cmd, opts) => { w.spawned.push({ cmd, cwd: opts.cwd }); stdins.push(opts.stdin); const s = openStub(cmd, (t) => script(t), (n) => streamOf(n)); stubs.push(s); return s as unknown as Child; };
    const inputFor = async (hop: Awaited<ReturnType<typeof w.api.startHop>>, cardId: string) => ({ project: (await w.api.projects()).find((p) => p.id === w.project.id)!, hop, worker: (await w.api.workers()).find((x) => x.id === w.worker.id)!, card: await w.api.card(cardId) });
    const hopOn = async (cardId: string) => w.api.startHop(w.project.id, { cardId, workerId: w.worker.id, claim: "inst-1" });
    return { ...w, pool, stubs, stdins, seen, inputFor, hopOn, setScript: (s: Script) => { script = s; }, setStream: (f: (n: number) => string[]) => { streamOf = f; } };
  }

  /** a task's stream the way the CLI prints it: one assistant line per model call (each with that call's usage), then a `result` whose usage SUMS every call of the task (TEST-121 DEF-1) */
  const callStream = (calls: { input: number; creation?: number; read?: number }[], sum: { input: number; creation?: number; read?: number }): string[] => [
    ...calls.map((u, i) => JSON.stringify({ type: "assistant", message: { id: `msg_${i}`, usage: { input_tokens: u.input, cache_creation_input_tokens: u.creation ?? 0, cache_read_input_tokens: u.read ?? 0, output_tokens: 20 } } })),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: sum.input, cache_creation_input_tokens: sum.creation ?? 0, cache_read_input_tokens: sum.read ?? 0, output_tokens: 60 } }),
  ];
  /** n more cards for the worker (the world's own two come first) */
  const moreCards = async (o: Awaited<ReturnType<typeof openWorld>>, n: number) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push((await newCard(o.call, o.project.id, { title: `more ${i}`, assigneeId: o.worker.id })).json);
    return out;
  };

  test("ONE child serves 3 hops: 3 messages on its stdin, each hop finished `commented`, every write carries that task's own hop id, the hop file is empty after", async () => {
    const o = await openWorld();
    const third = (await newCard(o.call, o.project.id, { title: "third", assigneeId: o.worker.id })).json;
    const hops = [o.hop];
    await runHop(o.deps, await o.input()); // hop 1: the world's own, on card #1
    for (const card of [o.other, third]) {
      const h = await o.hopOn(card.id);
      hops.push(h);
      await runHop(o.deps, await o.inputFor(h, card.id));
    }
    expect(o.spawned).toHaveLength(1);
    expect(o.stdins).toEqual(["pipe"]);
    const cmd = o.spawned[0]!.cmd;
    expect(cmd.slice(1, 4)).toEqual(["-p", "--input-format", "stream-json"]);
    expect(cmd.join(" ")).not.toContain("Your card is"); // the prompt is on stdin, not on the command line
    const stub = o.stubs[0]!;
    expect(stub.written).toHaveLength(3);
    const cards = [o.card, o.other, third];
    stub.written.forEach((line, i) => {
      const m = JSON.parse(line);
      expect([m.type, m.message.role]).toEqual(["user", "user"]);
      expect(m.message.content).toContain(`Your card is ${cards[i]!.id}`);
    });
    const finished = (await o.api.hops(o.project.id)).filter((h) => hops.some((x) => x.id === h.id));
    expect(finished.map((h) => h.outcome)).toEqual(["commented", "commented", "commented"]);
    expect(o.seen).toEqual(hops.map((h) => h.id)); // x-caw-hop = each hop's own id, read per task from the file
    expect(readFileSync(join(o.pool.dirOf(o.project.id, o.worker.id), "hop"), "utf8")).toBe(""); // between tasks a stray write gets hop_required
    expect(o.pool.sessions()).toEqual([{ projectId: o.project.id, workerId: o.worker.id, state: "idle" }]);
    expect(stub.killed).toBe(false); // the process lives on
    expect(stub.mcp.CAW_HOP_FILE).toBeString();
    expect(stub.mcp.CAW_HOP_ID).toBeUndefined(); // an open worker has no fixed hop id
  });

  test("a child that dies mid-task → the hop is `failed` with `exit 1` (today's rule), the pool drops it, and the NEXT hop spawns a new child", async () => {
    const o = await openWorld();
    o.setScript(async (t) => { if (t.n === 1) return "die"; });
    const first = await runHop(o.deps, await o.input());
    expect([first.hop.outcome, first.hop.note]).toEqual(["failed", expect.stringContaining("exit 1")]);
    expect(first.hop.note).toContain(NOTES.noResult);
    expect(o.pool.sessions()).toEqual([]); // dropped
    expect(o.spawned).toHaveLength(1);
    // the same worker's next task: a new process
    o.setScript(async (t) => { await o.call("POST", `/v1/cards/${o.other.id}/comments`, { text: "done" }, o.actor, { "x-caw-hop": t.hopFileId }); });
    const h2 = await o.hopOn(o.other.id);
    const second = await runHop(o.deps, await o.inputFor(h2, o.other.id));
    expect(second.hop.outcome).toBe("commented");
    expect(o.spawned).toHaveLength(2);
    expect(o.stubs[1]).not.toBe(o.stubs[0]);
  });

  test("the hop cap kills the open child: the hop is `stopped` with the timeout note, the worker is dropped, the next task starts a new process", async () => {
    const o = await openWorld({ hopMaxMs: 150 });
    o.setScript(async () => { await new Promise((r) => setTimeout(r, 1500)); }); // a task that never finishes in time
    const r = await runHop(o.deps, await o.input());
    expect(r.hop.outcome).toBe("stopped");
    expect(r.hop.note).toContain(NOTES.timeout);
    expect(o.stubs[0]!.killed).toBe(true);
    expect(o.pool.sessions()).toEqual([]);
  });

  // REQ-122 round 2 (SPEC-120 D3 r2, TEST-121 DEF-1): the restart rule reads the session's REAL context — the last call's prompt — not the task's summed usage
  test("(d) TEST-121 regression: tasks whose summed result usage is 241 000 each but whose last call's prompt is 54 865 → 5 tasks on ONE child with the default limit; the 6th restarts by the task count", async () => {
    const o = await openWorld();
    // a multi-call task: calls grow 25 849 → 40 000 → 54 865 (what the session really held), the result adds them up to 241 000 (≥ 238 884, the TEST-121 sum)
    o.setStream(() => callStream([{ input: 100, read: 25_749 }, { input: 100, creation: 5_000, read: 34_900 }, { input: 65, creation: 4_800, read: 50_000 }], { input: 1_000, creation: 20_000, read: 220_000 }));
    const cards = [o.card, ...(await moreCards(o, 5))]; // 6 cards: the world's `other` is not used
    const outcomes: (string | null)[] = [];
    for (let i = 0; i < 6; i++) {
      const hop = i === 0 ? o.hop : await o.hopOn(cards[i]!.id);
      const r = await runHop(o.deps, i === 0 ? await o.input() : await o.inputFor(hop, cards[i]!.id));
      outcomes.push(r.hop.outcome);
      if (i === 4) { // after 5 tasks: still ONE child, never restarted for its context
        expect(o.spawned).toHaveLength(1);
        expect(o.log.some((l) => l.includes("starting a new process"))).toBe(false);
      }
    }
    expect(outcomes).toEqual(Array(6).fill("commented"));
    expect(o.spawned).toHaveLength(2); // the 6th task: a new child …
    const why = o.log.filter((l) => l.includes("starting a new process"));
    expect(why).toHaveLength(1);
    expect(why[0]).toContain("it has done 5 tasks"); // … because of the task count, not the context
    expect(why[0]).not.toContain("last call's prompt");
    expect(o.stubs[0]!.written).toHaveLength(5);
    // the hop's own cost is the summed usage, as before: 1 000 + 20 000 + 220 000
    const done = (await o.api.hops(o.project.id)).find((h) => h.id === o.hop.id)!;
    expect(done.tokensIn).toBe(241_000);
  });
  test("(e) a task whose last call's prompt is 150 000 → the NEXT task starts a new child, and the log names `(the last call's prompt)`", async () => {
    const o = await openWorld();
    o.setStream(() => callStream([{ input: 100, read: 60_000 }, { input: 100, read: 149_900 }], { input: 200, read: 209_900 })); // last call = 150 000
    await runHop(o.deps, await o.input());
    expect(o.spawned).toHaveLength(1);
    const h2 = await o.hopOn(o.other.id);
    const r = await runHop(o.deps, await o.inputFor(h2, o.other.id));
    expect(r.hop.outcome).toBe("commented");
    expect(o.spawned).toHaveLength(2);
    expect(o.stubs[0]!.ended).toBe(true); // the old one was ended (stdin EOF)
    expect(o.log.some((l) => l.includes("its context reached 150000 tokens (the last call's prompt)"))).toBe(true);
  });
  test("a runner that is stopping does not touch the worker: the task's hop is left running for the next runner", async () => {
    const o = await openWorld();
    o.setScript(async () => { o.deps.stopping = () => true; }); // the runner is told to stop while the task runs
    const r = await runHop(o.deps, await o.input());
    expect(r.hop.endedAt).toBeNull(); // left running in the store
    o.deps.stopping = undefined;
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
  test("a hop that is stopped (killed on the 10th refusal) still leaves its trace", async () => {
    const w = await world();
    const traceDir = tmp("caw-trace-");
    w.set(() => fakeChild({ lines: tenRefusals(), hang: true })); // was: one hook block
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
  test("none after the stream has stopped: the 10th refusal ends the reading, the child is killed, and no heartbeat follows it", async () => {
    const h = await setupHb(ok);
    await h.at(31);                                                      // one heartbeat
    for (const l of tenRefusals()) { try { await h.s.push(l); } catch { break; } } // reaches the 10th refusal → the stream is stopped (was: one hook block)
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

  test("cwd = the first WRITABLE root, every other root (both kinds) is added, and the read-only one is denied Edit / Write (permission rules; the sandbox's denyWrite is gone, TASK-112)", async () => {
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
    expect(seen.sandbox?.filesystem).toBeUndefined(); // was: seen.sandbox.filesystem.denyWrite = [a] (TASK-112: no sandbox keys are added)
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
    expect(seen.sandbox?.filesystem?.denyWrite).toBeUndefined();
  });
  test("a project without `readOnly` (a core before A-094) is read as []", async () => {
    const w = await world();
    const inp = await w.input();
    let seen: any = null;
    w.set(() => { seen = settingsOf(w.spawned[w.spawned.length - 1]!.cmd); return fakeChild({ lines: fixture("ok") }); });
    await runHop(w.deps, { ...inp, project: { ...inp.project, workspace: { roots: inp.project.workspace.roots } } });
    expect(w.spawned[0]!.cwd).toBe(inp.project.workspace.roots[0]!);
    expect(seen.sandbox?.filesystem?.denyWrite).toBeUndefined();
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
    // was: "~/ denied for Bash reads, the roots and its own folder re-allowed (sandbox denyRead / allowRead), the file-tool guard hook …". TASK-112: the hook (now on Bash too) is the whole fence.
    test(`a ${chat ? "CHAT" : "CARD"} hop: the guard hook (Read|Glob|Grep|Bash) with the roots and its own folder, no sandbox keys, and no blockReads key`, async () => {
      const { seen, roots, hopDir } = await fence(chat);
      expect(seen.sandbox?.filesystem).toBeUndefined();
      const hook = seen.hooks.PreToolUse.find((h: any) => h.matcher === "Read|Glob|Grep|Bash"); // TASK-112: Bash joined the matcher
      expect(hook).toBeDefined();
      const args = JSON.parse(hook.hooks[0].command.slice(hook.hooks[0].command.indexOf("'[") + 1, -1));
      for (const d of [...roots, hopDir]) expect(args).toContain(d);
      expect(seen.permissions.blockReadsOutsideWorkingDirectories).toBeUndefined();
      expect("sandbox" in seen).toBe(false); // the runner switches no sandbox on (was: seen.sandbox.enabled === true)
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

// was: describe("read-guard refusals are SOFT, counted, and the 3rd stops the hop (TASK-C-042 Q2, Sector 2026-10-20)") — pinned "the 3rd read-guard refusal stops it" and "a git-push block
// stops at once". TASK-118 / SPEC-108 D4: NO refusal ends a hop (our hook, a workspace guard hook, a permission deny); the 10th one in a hop does. The note names the real reasons.
describe("refusals never end a hop; the 10th one does; the note names the real reasons (TASK-118, SPEC-108 D4/D5)", () => {
  const run = async (lines: string[], opts: { comment?: boolean; hang?: boolean } = {}) => {
    const w = await world();
    let child!: ReturnType<typeof fakeChild>;
    w.set(() => (child = fakeChild({ lines, hang: opts.hang, before: opts.comment === false ? undefined : commentBy(w) })));
    await runHop(w.deps, await w.input());
    return { w, child, h: await w.finished() };
  };

  test("two refusals of DIFFERENT codes → the hop goes on and ends `commented`; the note has both Thai sentences; the child is not killed", async () => {
    const { child, h, w } = await run([...gitWrite(1), ...notAllowed(2), ...fixture("ok")]);
    expect(child.killed).toBe(false);
    expect(h.outcome).toBe("commented");
    expect(h.note).toBe([SENTENCE("worker เขียน git ไม่ได้"), SENTENCE("docker ไม่ใช่คำสั่งที่ worker ใช้ได้")].join(" · "));
    expect(w.log.some((l) => l.includes("refused 1 of 10") && l.includes("git_write"))).toBe(true);
    expect(w.log.some((l) => l.includes("refused 2 of 10") && l.includes("not_allowed docker"))).toBe(true);
  });

  test("every code has its sentence: outside · read_only · not_allowed · shell_feature · git_write · network · inline_code · guard · tool", async () => {
    const one = async (lines: string[]) => (await run([...lines, ...fixture("ok")])).h.note;
    expect(await one(outsideRefusal(1, "/etc/hosts"))).toBe(SENTENCE("/etc/hosts อยู่นอกโฟลเดอร์งาน"));
    expect(await one(hookRefusal(1, "rm x", 'caw-refused read_only: "/ws/spec/x" is in a read-only folder — a worker cannot write there'))).toBe(SENTENCE("โฟลเดอร์ /ws/spec/x อ่านได้อย่างเดียว"));
    expect(await one(notAllowed(1, "docker"))).toBe(SENTENCE("docker ไม่ใช่คำสั่งที่ worker ใช้ได้"));
    expect(await one(hookRefusal(1, "echo $HOME", 'caw-refused shell_feature: "$" cannot be used in a command here — run plain commands'))).toBe(SENTENCE("ใช้ $ ในคำสั่งไม่ได้"));
    expect(await one(gitWrite(1))).toBe(SENTENCE("worker เขียน git ไม่ได้"));
    expect(await one(networkRefusal(1))).toBe(SENTENCE("ออกเน็ตได้แค่ 127.0.0.1 กับที่ลงแพ็กเกจ"));
    expect(await one(hookRefusal(1, "bun -e 1", 'caw-refused inline_code: "-e" runs code from the command line — write the code to a file first'))).toBe(SENTENCE("รันโค้ดจากบรรทัดคำสั่งไม่ได้ — เขียนเป็นไฟล์ก่อน"));
    expect(await one(guardRefusal(1))).toBe(SENTENCE("กฎความปลอดภัยกันไว้"));
    expect(await one(permissionDeny(1, "WebFetch"))).toBe(SENTENCE("เครื่องมือ WebFetch ใช้ในก้าวนี้ไม่ได้"));
  });

  // REQ-113 / TASK-125
  test("a `caw-refused api:` block (a worker reaching I-Space's own servers, or typing an identity header) → the PM's sentence, exactly; the hop goes on and ends `commented`", async () => {
    const SAYS = "worker เรียก API ของ CAW หรือ Blueprint ตรง ๆ ไม่ได้ — ใช้เครื่องมือของ CAW แทน";
    const server = hookRefusal(1, "curl http://127.0.0.1:4500/v1/projects", 'caw-refused api: "127.0.0.1:4500" is one of I-Space\'s own servers — a worker acts on CAW only through its MCP tools');
    const header = hookRefusal(2, "curl -H 'X-CAW-Actor: operator' http://127.0.0.1:3900/", 'caw-refused api: "X-CAW-Actor" is one of I-Space\'s own servers — a worker acts on CAW only through its MCP tools');
    const { h, child } = await run([...server, ...header, ...fixture("ok")]);
    expect(child.killed).toBe(false);
    expect(h.outcome).toBe("commented");
    expect(h.note).toBe(SENTENCE(SAYS)); // two refusals, one sentence: the reason does not name the detail, so they collapse
    expect(refusalOf({ kind: "hook", tool: "Bash", text: `PreToolUse:Bash hook error: [x]: caw-refused api: "127.0.0.1:4500" is one of …` })).toEqual({ kind: "api", detail: "127.0.0.1:4500" });
  });
  test("the hop gives the hook the servers' host:port from its config (card hop), as the 3rd argument with `[]` as the 2nd; a hop without config.serverPorts gives none", async () => {
    const hookCmd = async (ports: string[] | undefined) => {
      const w = await world();
      w.deps.config = { ...w.deps.config, serverPorts: ports };
      let seen = "";
      w.set(() => { const cmd = w.spawned[w.spawned.length - 1]!.cmd; const s = JSON.parse(readFileSync(cmd[cmd.indexOf("--settings") + 1]!, "utf8")); seen = s.hooks.PreToolUse.find((x: any) => x.matcher === "Read|Glob|Grep|Bash").hooks[0].command; return fakeChild({ lines: fixture("ok") }); });
      await runHop(w.deps, await w.input());
      return seen;
    };
    const ports = ["127.0.0.1:4500", "127.0.0.1:4200", "127.0.0.1:3100", "127.0.0.1:3500"];
    const withPorts = await hookCmd(ports);
    expect(withPorts.endsWith(` '[]' '${JSON.stringify(ports)}'`)).toBe(true);
    const without = await hookCmd(undefined);
    expect(without).not.toContain("127.0.0.1");
    expect(without.endsWith("]'")).toBe(true); // the one-argument form
  });
  test("a file-tool refusal by the read guard (`caw-refused outside: read guard: <path> is outside …`, the path unquoted) → the path is named", async () => {
    const lines = [toolUse("t1", "Read", { file_path: "/etc/hosts" }), JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true,
      content: "PreToolUse:Read hook error: [/x/read-guard.ts '[\"/r\"]']: caw-refused outside: read guard: /etc/hosts is outside the project's folders — a worker reads only inside them" }] } })];
    expect((await run([...lines, ...fixture("ok")])).h.note).toBe(SENTENCE("/etc/hosts อยู่นอกโฟลเดอร์งาน"));
  });

  test("the recorded old-format read-guard line (no `caw-refused` prefix, kept as history) is read as a workspace guard: soft, `กฎความปลอดภัยกันไว้`", async () => {
    const { h, child } = await run([...fixture("read-guard"), ...fixture("ok")]);
    expect(child.killed).toBe(false);
    expect([h.outcome, h.note]).toEqual(["commented", SENTENCE("กฎความปลอดภัยกันไว้")]);
  });

  test("the same refusal many times is ONE sentence; at most 3 distinct sentences, then `(อีก n ครั้ง)` for the refusals those three do not cover", async () => {
    // distinct: git_write(commit), docker, network(url), make, /etc/x   ·  repeats: git_write again → 6 refusals, 5 distinct, shown 3 → uncovered = make + /etc/x = 2
    const lines = [gitWrite(1), notAllowed(2), networkRefusal(3), notAllowed(4, "make"), outsideRefusal(5, "/etc/x"), gitWrite(6)].flat();
    const { h } = await run([...lines, ...fixture("ok")]);
    expect(h.outcome).toBe("commented");
    expect(h.note).toBe([SENTENCE("worker เขียน git ไม่ได้"), SENTENCE("docker ไม่ใช่คำสั่งที่ worker ใช้ได้"), SENTENCE("ออกเน็ตได้แค่ 127.0.0.1 กับที่ลงแพ็กเกจ"), "(อีก 2 ครั้ง)"].join(" · "));
    const same = await run([...[1, 2, 3, 4].flatMap((n) => gitWrite(n)), ...fixture("ok")]);
    expect(same.h.note).toBe(SENTENCE("worker เขียน git ไม่ได้")); // four times, one sentence, no `(อีก …)`
  });

  test("9 refusals are still fine: the hop goes on and ends commented", async () => {
    const nine = tenRefusals().slice(0, tenRefusals().length - 2); // drop the 10th pair (a tool_use + its result)
    const { h, child } = await run([...nine, ...fixture("ok")]);
    expect(child.killed).toBe(false);
    expect(h.outcome).toBe("commented");
    expect(h.note).not.toContain("หยุดไว้");
  });

  test("the 10th refusal stops the hop: `stopped`, the cap note first, then the reasons, then the tools; the child is killed; the log says so", async () => {
    const { h, child, w } = await run([...tenRefusals(), ...fixture("ok")], { hang: true, comment: false });
    expect(child.killed).toBe(true);
    expect(h.outcome).toBe("stopped");
    expect(h.note.startsWith("หยุดไว้: คำสั่งถูกปฏิเสธครบ 10 ครั้งในก้าวเดียว · ")).toBe(true);
    expect(h.note).toContain(SENTENCE("worker เขียน git ไม่ได้"));
    expect(h.note).toContain("(อีก ");
    expect(w.log.some((l) => l.includes("refused 10 of 10"))).toBe(true);
    expect(w.log.some((l) => l.includes("10 refusals in one hop — hop stopped"))).toBe(true);
  });

  test("the cap counts every kind together: our hook, a workspace guard hook and a permission deny", async () => {
    const mixed = [gitWrite(0), guardRefusal(1), permissionDeny(2), gitWrite(3), guardRefusal(4), permissionDeny(5), gitWrite(6), guardRefusal(7), permissionDeny(8)].flat();
    expect((await run([...mixed, ...fixture("ok")])).h.outcome).toBe("commented"); // 9
    const ten = [...mixed, ...gitWrite(9)];
    const { h, child } = await run([...ten, ...fixture("ok")], { hang: true, comment: false });
    expect([h.outcome, child.killed]).toEqual(["stopped", true]);
  });

  test("a hop that FAILS after refusals carries all of it: the no-result sentence, the refusal sentences, the tool summary", async () => {
    const { h } = await run([...gitWrite(1), ...fixture("ok")], { comment: false });
    expect(h.outcome).toBe("failed");
    const parts = h.note.split(" · ");
    expect(parts[0]).toBe(NOTES.noResult);
    expect(parts).toContain(SENTENCE("worker เขียน git ไม่ได้"));
    expect(h.note).toContain("tools:");
  });

  test("a refusal is not an outcome: the card's result is still what the worker wrote (a comment → commented), with or without refusals", async () => {
    const without = await run([...fixture("ok")]);
    const withRefusal = await run([...gitWrite(1), ...fixture("ok")]);
    expect([without.h.outcome, without.h.note]).toEqual(["commented", ""]);
    expect(withRefusal.h.outcome).toBe("commented");
  });

  test("no refusal, no words in the note", async () => {
    const { h } = await run(fixture("ok"));
    expect(h.note).toBe("");
  });
});

describe("refusalOf and refusedNote on their own", () => {
  test("refusalOf reads the code and the first quoted detail after `caw-refused <code>: ` — not the quotes in the hook's own command line", () => {
    const text = (stderr: string) => `PreToolUse:Bash hook error: [/bun /x/read-guard.ts '["/a","/b"]']: ${stderr}`;
    expect(refusalOf({ kind: "hook", tool: "Bash", text: text('caw-refused network: "https://example.com" reaches the network — "x"') })).toEqual({ kind: "network", detail: "https://example.com" });
    expect(refusalOf({ kind: "hook", tool: "Bash", text: text("caw-refused outside: read guard: /etc/hosts is outside the project's folders — x") })).toEqual({ kind: "outside", detail: "/etc/hosts" });
    expect(refusalOf({ kind: "hook", tool: "Bash", text: text('caw-refused git_write: "commit" is not allowed') })).toEqual({ kind: "git_write", detail: "commit" });
    expect(refusalOf({ kind: "hook", tool: "Bash", text: text("Blocked by the overnight guard (git push)") })).toEqual({ kind: "guard", detail: "" });
    expect(refusalOf({ kind: "hook", tool: "Read", text: "PreToolUse:Read hook error: [x]: read guard: /a is outside the project's folders" })).toEqual({ kind: "guard", detail: "" });
    expect(refusalOf({ kind: "permission", tool: "WebSearch", text: "permission denied" })).toEqual({ kind: "tool", detail: "WebSearch" });
    expect(refusalOf({ kind: "hook", tool: "Bash", text: text("caw-refused made_up_code: x") })).toEqual({ kind: "guard", detail: "" }); // an unknown code is not trusted
  });
  test("refusedNote: distinct as the reader sees it — `git commit` and `git push` are ONE sentence; two different paths are two; the uncovered count follows the sentences, not the details", () => {
    const g = (detail: string) => ({ kind: "git_write" as const, detail });
    expect(refusedNote([g("commit"), g("push"), g("branch")])).toBe(SENTENCE("worker เขียน git ไม่ได้"));
    expect(refusedNote([{ kind: "outside", detail: "/a" }, { kind: "outside", detail: "/b" }])).toBe([SENTENCE("/a อยู่นอกโฟลเดอร์งาน"), SENTENCE("/b อยู่นอกโฟลเดอร์งาน")].join(" · "));
    const four = [g("x"), { kind: "outside" as const, detail: "/a" }, { kind: "outside" as const, detail: "/b" }, { kind: "outside" as const, detail: "/c" }, { kind: "outside" as const, detail: "/d" }, g("y")];
    expect(refusedNote(four).endsWith(" · (อีก 2 ครั้ง)")).toBe(true); // shown: git, /a, /b → not covered: /c and /d
  });
  test("refusedNote: empty list → empty; redacts what it prints", () => {
    expect(refusedNote([])).toBe("");
    expect(refusedNote([{ kind: "not_allowed", detail: "token=abc999" }])).toBe(SENTENCE("token=*** ไม่ใช่คำสั่งที่ worker ใช้ได้"));
  });
});

describe("the worker's screen: what the child prints is also sent, rendered and redacted (REQ-104, SPEC-103 § The runner 4)", () => {
  const comment = (w: Awaited<ReturnType<typeof world>>) => async () => { await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "done" }, w.actor); };
  const KEY = "sk-test-abcdefghijklmnopqrstuvwx";
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", model: "stub-model" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first line\nsecond line" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `leaked ${KEY} and topsecretvalue and token=abc123` }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__caw__comment", input: { text: "hi" } }] } }),
    "this line is not JSON",
    JSON.stringify({ type: "result", subtype: "success", num_turns: 2 }),
  ];
  const outputOf = async (w: Awaited<ReturnType<typeof world>>) => (await w.call("GET", `/v1/hops/${w.hop.id}/output`)).json as { entries: { seq: number; kind: string; text: string }[]; more: boolean };

  test("a hop whose child prints lines → the API holds them in order, redacted (a bare key, a known value, token=), and the hop ends as before", async () => {
    const w = await world();
    w.deps.secrets = ["topsecretvalue"];
    w.set(() => fakeChild({ lines: stream, before: comment(w) }));
    await runHop(w.deps, await w.input());
    const out = await outputOf(w);
    expect(out.entries.map((e) => e.text)).toEqual([
      "● session stub-model", "first line", "second line", "leaked *** and *** and token=***", "▸ comment {\"text\":\"hi\"}", "■ success · turns 2",
    ]);
    expect(out.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(out.entries.every((e) => e.kind === "line")).toBe(true);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(JSON.stringify(out)).not.toContain("topsecretvalue");
    expect((await w.finished()).outcome).toBe("commented");
  });

  test("AC-6: a hop whose output POSTs all fail ends with the SAME outcome, note and tokens as one without any trouble — the failure is only logged", async () => {
    const good = await world();
    good.set(() => fakeChild({ lines: stream, before: comment(good) }));
    await runHop(good.deps, await good.input());
    const g = await good.finished(); // read now: the next world() empties the shared test database

    const bad = await world();
    bad.deps.api = { ...bad.api, hopOutput: async () => { throw new RunnerApiError(500, "internal", "boom"); } };
    bad.set(() => fakeChild({ lines: stream, before: comment(bad) }));
    await runHop(bad.deps, await bad.input());

    const b = await bad.finished();
    expect([b.outcome, b.note, b.tokensIn, b.tokensOut]).toEqual([g.outcome, g.note, g.tokensIn, g.tokensOut]);
    expect(b.outcome).toBe("commented");
    expect((await outputOf(bad)).entries).toEqual([]);
    expect(bad.log.some((l) => l.includes("screen output not sent") && l.includes("boom"))).toBe(true);
    expect(bad.log.filter((l) => l.includes("screen output not sent"))).toHaveLength(1);
  });

  test("AC-6: output POSTs that never answer do not hold the hop longer than the 3 s close — same outcome again", async () => {
    const w = await world();
    w.deps.api = { ...w.api, hopOutput: () => new Promise(() => {}) };
    w.set(() => fakeChild({ lines: stream, before: comment(w) }));
    const t0 = Date.now();
    await runHop(w.deps, await w.input());
    expect(Date.now() - t0).toBeLessThan(6000);
    expect((await w.finished()).outcome).toBe("commented");
  }, 15_000);

  test("a child that prints nothing stores nothing, and the hop ends as before", async () => {
    const w = await world();
    w.set(() => fakeChild({ lines: [], before: comment(w) }));
    await runHop(w.deps, await w.input());
    expect((await outputOf(w)).entries).toEqual([]);
    expect((await w.finished()).outcome).toBe("commented");
  });
});

describe("folder confinement: no claude on a project folder outside CAW_WORKSPACE_ROOT (TASK-112, owner 13:41 — no Bash sandbox, the folders are the fence)", () => {
  const NOTE = "โฟลเดอร์งานต้องอยู่ใน CAW_WORKSPACE_ROOT — ก้าวนี้ไม่ได้เริ่ม";
  const refusedHop = async (roots: string[]) => {
    const w = await world({ roots });
    w.set(() => fakeChild({ lines: fixture("ok"), before: async () => { await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "done" }, w.actor); } }));
    await runHop(w.deps, await w.input());
    return { w, h: await w.finished() };
  };

  test("a project root outside CAW_WORKSPACE_ROOT → stopped with the PM's note, claude not spawned, one log line naming the folder", async () => {
    const outside = tmp("caw-hop-outside-");
    const { w, h } = await refusedHop([outside]);
    expect([h.outcome, h.note]).toEqual(["stopped", NOTE]);
    expect(w.spawned).toHaveLength(0);
    expect(w.log.filter((l) => l.includes("not inside CAW_WORKSPACE_ROOT") && l.includes(outside))).toHaveLength(1);
    expect(existsSync(join(w.tmpRoot, `hop-${h.id}`))).toBe(false); // nothing was set up for it
  });

  test("one bad root among good ones refuses the whole hop (a read-only folder counts too)", async () => {
    const good = inWs("caw-hop-good-");
    const { w, h } = await refusedHop([good, tmp("caw-hop-outside-")]);
    expect([h.outcome, h.note, w.spawned.length]).toEqual(["stopped", NOTE, 0]);
  });

  test("a root equal to CAW_WORKSPACE_ROOT, or under its scripts/ or .claude/ → refused", async () => {
    mkdirSync(join(WS, "scripts", "x"), { recursive: true });
    mkdirSync(join(WS, ".claude", "x"), { recursive: true });
    for (const bad of [WS, join(WS, "scripts"), join(WS, "scripts", "x"), join(WS, ".claude"), join(WS, ".claude", "x"), join(WS, ".claude", "skills", "role-be")]) {
      const { w, h } = await refusedHop([bad]);
      expect([bad, h.outcome, h.note, w.spawned.length]).toEqual([bad, "stopped", NOTE, 0]);
    }
  });

  test("a '..' that climbs out, and a symlink inside CAW_WORKSPACE_ROOT that points outside → refused (the real path decides)", async () => {
    const outside = tmp("caw-hop-outside-");
    const link = join(inWs("caw-hop-link-"), "out");
    symlinkSync(outside, link);
    for (const bad of [link, join(WS, "..", "somewhere-else")]) {
      const { w, h } = await refusedHop([bad]);
      expect([bad.endsWith("somewhere-else") ? "dotdot" : "symlink", h.outcome, w.spawned.length]).toEqual([bad.endsWith("somewhere-else") ? "dotdot" : "symlink", "stopped", 0]);
    }
  });

  test("roots inside CAW_WORKSPACE_ROOT (a sub-folder, a nested one, one that does not exist yet) → spawns as before", async () => {
    const a = inWs("caw-hop-in-");
    const nested = join(a, "deep", "er");
    mkdirSync(nested, { recursive: true });
    const w = await world({ roots: [a, nested] });
    w.set(() => fakeChild({ lines: fixture("ok"), before: async () => { await w.call("POST", `/v1/cards/${w.card.id}/comments`, { text: "done" }, w.actor); } }));
    await runHop(w.deps, await w.input());
    expect(w.spawned).toHaveLength(1);
    expect((await w.finished()).outcome).toBe("commented");
  });

  test("folderOutsideWorkspace on its own: null for inside, the folder for outside; no folders → null", () => {
    expect(folderOutsideWorkspace([], WS)).toBeNull();
    expect(folderOutsideWorkspace([join(WS, "p")], WS)).toBeNull();
    expect(folderOutsideWorkspace([join(WS, "p"), "/etc"], WS)).toBe("/etc");
    expect(folderOutsideWorkspace([WS + "-sibling"], WS)).toBe(WS + "-sibling"); // a sibling whose name starts like it is not inside
  });
});
