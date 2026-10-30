import { describe, expect, test } from "bun:test";
import { ConfigError, HOOKS, loadConfig } from "./config";

const ROOT = "/ws/ai-agent-workspace";
const allHooks = (p: string) => HOOKS.some((h) => p === `${ROOT}/scripts/hooks/${h}`);
/** the hooks under /ws do not exist on this machine: say they exist and are executable, unless a test says otherwise */
const load = (e: Record<string, string | undefined>, exists: (p: string) => boolean = allHooks, isExec: (p: string) => boolean = () => true) => loadConfig(e, exists, isExec);
const env = (over: Record<string, string | undefined> = {}) => ({ CAW_WORKSPACE_ROOT: ROOT, ...over });

describe("loadConfig", () => {
  test("defaults — and an EMPTY value (what Bun hands over from a blank .env line) falls back too", () => {
    const c = load(env({ CAW_API_URL: "", RUNNER_POLL_MS: "", RUNNER_HOP_MAX_MS: "", CLAUDE_BIN: "" }), allHooks);
    expect(c.apiUrl).toBe("http://127.0.0.1:4500");
    expect(c.pollMs).toBe(2000);
    expect(c.hopMaxMs).toBe(1_200_000);
    expect(c.claudeBin).toBe(`${process.env.HOME}/.local/bin/claude`);
    expect(c.workspaceRoot).toBe(ROOT);
    expect(c.hooks).toEqual(HOOKS.map((h) => `${ROOT}/scripts/hooks/${h}`));
  });

  test("values are taken, `~/` is expanded, a trailing slash on the root is dropped", () => {
    const c = load(env({ CAW_WORKSPACE_ROOT: `${ROOT}/`, RUNNER_POLL_MS: "500", CLAUDE_BIN: "~/bin/claude", CAW_API_URL: "http://127.0.0.1:4530" }), allHooks);
    expect(c.pollMs).toBe(500);
    expect(c.claudeBin).toBe(`${process.env.HOME}/bin/claude`);
    expect(c.workspaceRoot).toBe(ROOT);
    expect(c.apiUrl).toBe("http://127.0.0.1:4530");
  });

  test("refuses to start without CAW_WORKSPACE_ROOT (unset or empty)", () => {
    expect(() => load({}, allHooks)).toThrow(ConfigError);
    expect(() => load({ CAW_WORKSPACE_ROOT: "" }, allHooks)).toThrow(/CAW_WORKSPACE_ROOT/);
  });

  test("refuses a relative workspace root (the hooks must be absolute — R-1)", () => {
    expect(() => load({ CAW_WORKSPACE_ROOT: "ai-agent-workspace" }, allHooks)).toThrow(/absolute/);
  });

  test("refuses to start when any one of the three hooks is missing, and names it", () => {
    const missing = HOOKS[1]!;
    expect(() => load(env(), (p) => !p.endsWith(missing))).toThrow(missing);
  });

  test("refuses a hook that exists but is not executable — the shell would exit 126, which Claude Code treats as 'no block'", () => {
    const notExec = HOOKS[0]!;
    expect(() => load(env(), allHooks, (p) => !p.endsWith(notExec))).toThrow(/not executable.*block-shell-edits/);
  });

  // REQ-122 (SPEC-120 D3): the open worker's three limits — default, set, bad (and a blank .env line falls back too)
  test("open worker limits — defaults 5 tasks, 150 000 tokens, 30 min idle; an empty value falls back", () => {
    const c = load(env(), allHooks);
    expect([c.workerMaxTasks, c.workerMaxTokens, c.workerIdleMs]).toEqual([5, 150_000, 1_800_000]);
    const blank = load(env({ RUNNER_WORKER_MAX_TASKS: "", RUNNER_WORKER_MAX_TOKENS: "", RUNNER_WORKER_IDLE_MS: "" }), allHooks);
    expect([blank.workerMaxTasks, blank.workerMaxTokens, blank.workerIdleMs]).toEqual([5, 150_000, 1_800_000]);
  });
  test("open worker limits — RUNNER_WORKER_MAX_TASKS / _MAX_TOKENS / _IDLE_MS are taken", () => {
    const c = load(env({ RUNNER_WORKER_MAX_TASKS: "2", RUNNER_WORKER_MAX_TOKENS: "9000", RUNNER_WORKER_IDLE_MS: "60000" }), allHooks);
    expect([c.workerMaxTasks, c.workerMaxTokens, c.workerIdleMs]).toEqual([2, 9000, 60000]);
  });
  test("open worker limits — one that is not a positive number refuses to start and names the variable", () => {
    expect(() => load(env({ RUNNER_WORKER_MAX_TASKS: "abc" }), allHooks)).toThrow(/RUNNER_WORKER_MAX_TASKS/);
    expect(() => load(env({ RUNNER_WORKER_MAX_TOKENS: "0" }), allHooks)).toThrow(/RUNNER_WORKER_MAX_TOKENS/);
    expect(() => load(env({ RUNNER_WORKER_IDLE_MS: "-5" }), allHooks)).toThrow(/RUNNER_WORKER_IDLE_MS/);
    expect(() => load(env({ RUNNER_WORKER_MAX_TASKS: "abc" }), allHooks)).toThrow(ConfigError);
  });

  test("refuses a poll or timeout that is not a positive number", () => {
    expect(() => load(env({ RUNNER_POLL_MS: "abc" }), allHooks)).toThrow(/RUNNER_POLL_MS/);
    expect(() => load(env({ RUNNER_HOP_MAX_MS: "0" }), allHooks)).toThrow(/RUNNER_HOP_MAX_MS/);
  });

  // ---- REQ-113 / TASK-125: serverPorts = the servers a worker must never reach ----
  test("serverPorts — defaults: CAW's API 4500, Blueprint 4200, Blueprint web 3100, caw-front 3500 (no variable for that one)", () => {
    const c = load(env(), allHooks);
    expect([...c.serverPorts!].sort()).toEqual(["127.0.0.1:3100", "127.0.0.1:3500", "127.0.0.1:4200", "127.0.0.1:4500"]);
    // an EMPTY value (a blank .env line) falls back to the default, like every other variable here
    expect([...load(env({ CAW_API_URL: "", BLUEPRINT_URL: "", BLUEPRINT_WEB_URL: "" }), allHooks).serverPorts!].sort()).toEqual([...c.serverPorts!].sort());
  });
  test("serverPorts — overrides are taken (host:port of each URL); a URL with no port gets 80 / 443 by scheme; duplicates collapse", () => {
    const c = load(env({ CAW_API_URL: "http://127.0.0.1:4530", BLUEPRINT_URL: "http://10.0.0.5:8080/api", BLUEPRINT_WEB_URL: "https://web.example.com" }), allHooks);
    expect([...c.serverPorts!].sort()).toEqual(["10.0.0.5:8080", "127.0.0.1:3500", "127.0.0.1:4530", "web.example.com:443"]);
    expect(load(env({ BLUEPRINT_URL: "http://localhost" }), allHooks).serverPorts).toContain("localhost:80");
    const same = load(env({ CAW_API_URL: "http://127.0.0.1:3500", BLUEPRINT_URL: "http://127.0.0.1:3500" }), allHooks).serverPorts!;
    expect(same.filter((p) => p === "127.0.0.1:3500")).toHaveLength(1);
    expect(load(env({ BLUEPRINT_URL: "http://[::1]:4200" }), allHooks).serverPorts).toContain("[::1]:4200");
  });
  test("serverPorts — a value that is not a URL is skipped with ONE warning that names the variable (never the value), and the runner still starts", () => {
    const warned: string[] = [];
    const c = loadConfig(env({ BLUEPRINT_URL: "secret-not-a-url", BLUEPRINT_WEB_URL: "localhost:3100" }), allHooks, () => true, (l) => warned.push(l));
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain("BLUEPRINT_URL");
    expect(warned[1]).toContain("BLUEPRINT_WEB_URL");
    for (const w of warned) { expect(w).not.toContain("secret-not-a-url"); expect(w).not.toContain("\n"); }
    expect([...c.serverPorts!].sort()).toEqual(["127.0.0.1:3500", "127.0.0.1:4500"]); // the two good ones survive
    // the same for the API URL itself, and a credential in a good URL is not echoed anywhere
    const w2: string[] = [];
    const d = loadConfig(env({ CAW_API_URL: "nonsense", BLUEPRINT_URL: "http://u:pw99@host:9/x" }), allHooks, () => true, (l) => w2.push(l));
    expect(w2).toHaveLength(1);
    expect(w2[0]).toContain("CAW_API_URL");
    expect(JSON.stringify([w2, d.serverPorts])).not.toContain("pw99");
    expect(d.serverPorts).toContain("host:9");
  });
  test("serverPorts — the hook paths and every other field are as before", () => {
    const c = load(env(), allHooks);
    expect(c.hooks).toEqual(HOOKS.map((h) => `${ROOT}/scripts/hooks/${h}`));
    expect(c.apiUrl).toBe("http://127.0.0.1:4500");
  });

  test("the error is ONE line (what main prints before exit 1)", () => {
    try { load({}, allHooks); } catch (e) { expect((e as Error).message).not.toContain("\n"); return; }
    throw new Error("did not throw");
  });
});
