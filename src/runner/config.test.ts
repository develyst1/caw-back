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

  test("refuses a poll or timeout that is not a positive number", () => {
    expect(() => load(env({ RUNNER_POLL_MS: "abc" }), allHooks)).toThrow(/RUNNER_POLL_MS/);
    expect(() => load(env({ RUNNER_HOP_MAX_MS: "0" }), allHooks)).toThrow(/RUNNER_HOP_MAX_MS/);
  });

  test("the error is ONE line (what main prints before exit 1)", () => {
    try { load({}, allHooks); } catch (e) { expect((e as Error).message).not.toContain("\n"); return; }
    throw new Error("did not throw");
  });
});
