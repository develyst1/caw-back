import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOKS } from "./config";
import { READ_GUARD_SCRIPT, WORKER_ALLOW, buildSettings, withReadGuard, withReadOnly, writeSettings } from "./settings";

const ROOT = "/ws/ai-agent-workspace";
const hookPaths = HOOKS.map((h) => `${ROOT}/scripts/hooks/${h}`);
const commands = (m: any) => m.hooks.map((h: any) => h.command);

describe("buildSettings (SPEC-C-003 § 2, R-1, R-4)", () => {
  const s: any = buildSettings(hookPaths);

  test("no $CLAUDE_PROJECT_DIR anywhere — a relative hook failed OPEN from a foreign cwd (TASK-C-029)", () => {
    expect(JSON.stringify(s)).not.toContain("CLAUDE_PROJECT_DIR");
  });

  test("Bash runs all three hooks, each by absolute path; Edit|Write|MultiEdit runs block-irreversible", () => {
    const pre = s.hooks.PreToolUse;
    const bash = pre.find((m: any) => m.matcher === "Bash");
    expect(commands(bash)).toEqual(hookPaths);
    const edit = pre.find((m: any) => m.matcher === "Edit|Write|MultiEdit");
    expect(commands(edit)).toEqual([hookPaths[1]]);
    for (const c of [...commands(bash), ...commands(edit)]) expect(c.startsWith("/")).toBe(true);
  });

  test("the allow list is the read-only and test commands, plus CAW's five MCP tools and nothing else", () => {
    expect(s.permissions.allow).toEqual([...WORKER_ALLOW]);
    expect(s.permissions.allow).toContain("Bash(git status *)");
    expect(s.permissions.allow).toContain("Bash(bun test *)");
    const mcp = (s.permissions.allow as string[]).filter((a) => a.startsWith("mcp__"));
    expect(mcp).toEqual([
      "mcp__caw__card_context", "mcp__caw__comment", "mcp__caw__hand_off", "mcp__caw__set_status", "mcp__caw__ask_operator",
      "mcp__caw__chat_context", "mcp__caw__locate", "mcp__caw__propose_cards", "mcp__caw__send_amendment", "mcp__caw__reply", // the entry worker's chat hop (TASK-C-034)
      "mcp__caw__save_code_map", // the setup step's result (TASK-C-041, contract v1.16)
    ]);
  });

  test("the MCP tools are allowed by name — without it `-p` denies the worker's own card_context call (found by the first real hop)", () => {
    expect((s.permissions.allow as string[]).some((a) => a === "mcp__caw" || a.endsWith("__*"))).toBe(false); // named tools, not the whole server
  });

  test("none of the forbidden allows: no git writes, no network tool, no generic interpreter (R-4)", () => {
    const allow: string[] = s.permissions.allow;
    const bad = [/git (add|commit|branch|checkout|worktree|push|tag|reset|clean)/, /\b(curl|wget|nc|ssh|scp)\b/, /^Bash\((node|python3?|bun|bunx|sh|bash|zsh|perl|ruby|deno|npx) \*\)$/];
    for (const a of allow) for (const re of bad) expect(re.test(a)).toBe(false);
    expect(allow.some((a) => a === "Bash" || a === "Bash(*)")).toBe(false);
  });

  test("`find` is gone from the allow list (`find . -exec …` runs anything) and its dangerous forms are denied, as is `git diff --output` (an arbitrary file write)", () => {
    expect((s.permissions.allow as string[]).some((a) => a.startsWith("Bash(find"))).toBe(false);
    for (const d of ["Bash(find * -exec*)", "Bash(find * -execdir*)", "Bash(git diff --output*)"]) expect(s.permissions.deny).toContain(d);
  });

  test("network tools are also DENIED, so a broad allow added later cannot open them", () => {
    for (const t of ["curl", "wget", "nc", "ssh", "scp"]) expect(s.permissions.deny).toContain(`Bash(${t} *)`);
  });

  // was: "the Bash sandbox is on, cannot be switched off by the model, and has no network domain allowed (R-4)". TASK-112 (owner 13:41 and 14:03): no sandbox key at all.
  test("there is NO `sandbox` key: the Bash sandbox is not used (it needs socat/bubblewrap); the network tools stay denied by name instead", () => {
    expect("sandbox" in s).toBe(false);
    expect(JSON.stringify(s)).not.toContain("sandbox");
    for (const t of ["curl", "wget", "nc", "ssh", "scp"]) expect(s.permissions.deny).toContain(`Bash(${t} *)`);
  });

  test("the three built-in plugins every hop loaded are switched OFF (R-5; TASK-C-035 item 2 (i))", () => {
    expect(s.enabledPlugins).toEqual({ "cc-plugin-agents-md@builtin": false, "cc-plugin-telemetry@builtin": false, "cc-plugin-plugin-authoring@builtin": false });
    expect(s.env).toEqual({ ENABLE_TOOL_SEARCH: "false" }); // MCP tools loaded upfront, no ToolSearch turn (TASK-C-036; code.claude.com/docs/en/mcp, Configure tool search)
  });

  test("the rest of `permissions` is exactly what it was: the allow list and the deny list, byte for byte (TASK-C-042 changes nothing else)", () => {
    const { blockReadsOutsideWorkingDirectories, ...rest } = s.permissions;
    expect(Object.keys(rest).sort()).toEqual(["allow", "deny"]);
    expect(rest.allow).toEqual([...WORKER_ALLOW]);
    expect(rest.deny).toEqual([
      "Bash(curl *)", "Bash(wget *)", "Bash(nc *)", "Bash(ssh *)", "Bash(scp *)",
      "Bash(find * -exec*)", "Bash(find * -execdir*)", "Bash(git diff --output*)",
    ]);
    expect(Object.keys(s).sort()).toEqual(["enabledPlugins", "env", "hooks", "permissions"]); // was with "sandbox" (TASK-112)
  });

  test("a hook path with a space is single-quoted so the shell runs one file", () => {
    const q: any = buildSettings(["/my ws/scripts/hooks/a.sh", "/my ws/scripts/hooks/b.sh", "/my ws/scripts/hooks/c.sh"]);
    expect(commands(q.hooks.PreToolUse[0])[0]).toBe("'/my ws/scripts/hooks/a.sh'");
  });
});

describe("writeSettings", () => {
  test("writes settings.json under the given temp folder, never inside the repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "caw-runner-test-"));
    try {
      const file = writeSettings(dir, hookPaths);
      expect(file).toBe(join(dir, "settings.json"));
      expect(JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true }); }
    expect(existsSync(dir)).toBe(false);
  });
});

describe("temp files are private to the user (security review)", () => {
  test("the settings folder is 0700 and settings.json is 0600", () => {
    const base = mkdtempSync(join(tmpdir(), "caw-runner-test-"));
    try {
      const dir = join(base, "inner");
      const file = writeSettings(dir, hookPaths);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally { rmSync(base, { recursive: true }); }
  });
});

describe("withReadOnly — the per-hop settings for read-only folders (TASK-C-042 Part B, D-100)", () => {
  const base: any = buildSettings(hookPaths);
  const before = JSON.stringify(base);

  test("no read-only folder: the base settings come back as they are", () => {
    expect(withReadOnly(base, [])).toEqual(base);
  });
  test("each read-only folder gets Edit and Write denied (permission paths: // for absolute); no sandbox denyWrite any more (TASK-112)", () => {
    const s: any = withReadOnly(base, ["/Users/x/spec", "/srv/api"]);
    for (const d of ["Edit(//Users/x/spec/**)", "Write(//Users/x/spec/**)", "Edit(//srv/api/**)", "Write(//srv/api/**)"]) expect(s.permissions.deny).toContain(d);
    expect("sandbox" in s).toBe(false);
  });
  test("everything else stays: the original deny entries, the allow list, the hooks, the plugins and the env", () => {
    const s: any = withReadOnly(base, ["/Users/x/spec"]);
    expect(s.permissions.deny.slice(0, base.permissions.deny.length)).toEqual(base.permissions.deny);
    expect(s.permissions.allow).toEqual(base.permissions.allow);
    expect(s.hooks).toEqual(base.hooks);
    expect(s.enabledPlugins).toEqual(base.enabledPlugins);
    expect(s.env).toEqual(base.env);
  });
  test("the base object is not changed (a pure function)", () => {
    withReadOnly(base, ["/a", "/b"]);
    expect(JSON.stringify(base)).toBe(before);
  });
  test("a trailing slash does not produce a double slash", () => {
    const s: any = withReadOnly(base, ["/Users/x/spec/"]);
    expect(s.permissions.deny).toContain("Edit(//Users/x/spec/**)");
    expect(s.permissions.deny).not.toContain("Edit(//Users/x/spec//**)");
  });
});

describe("withReadGuard — the read fence of every hop (TASK-C-042 Part A, UP-3)", () => {
  const base: any = buildSettings(hookPaths);
  const before = JSON.stringify(base);
  const readable = ["/work/usb-oda", "/work/mc2-front", "/tmp/caw-runner-x/hop-1"];

  // was: "the Bash sandbox: ~/ is denied for reads, and exactly the readable folders are re-allowed". TASK-112: the fence for Bash is the hook below, not sandbox keys.
  test("no sandbox keys: the read fence for Bash is the hook, so withReadGuard adds `hooks` and nothing else", () => {
    const s: any = withReadGuard(base, readable);
    expect("sandbox" in s).toBe(false);
    expect(Object.keys(s).sort()).toEqual(Object.keys(base).sort());
  });
  test("the file tools and Bash: a PreToolUse hook on Read|Glob|Grep|Bash runs the guard with the readable folders as ONE argument (JSON), not through the environment", () => {
    const s: any = withReadGuard(base, readable);
    const m = s.hooks.PreToolUse.find((h: any) => h.matcher === "Read|Glob|Grep|Bash"); // TASK-112: Bash joined the matcher (was "Read|Glob|Grep")
    expect(m.hooks).toHaveLength(1);
    const cmd: string = m.hooks[0].command;
    expect(cmd.startsWith(`${process.execPath} `)).toBe(true);
    expect(cmd).toContain(READ_GUARD_SCRIPT);
    expect(cmd.endsWith(`'${JSON.stringify(readable)}'`)).toBe(true);
    expect(READ_GUARD_SCRIPT.startsWith("/")).toBe(true);
    expect(READ_GUARD_SCRIPT.endsWith("src/runner/read-guard.ts")).toBe(true);
    expect(m.hooks[0]).not.toHaveProperty("env"); // no environment variable carries the list
    expect(cmd).not.toContain("$");
  });
  test("the existing hooks (Bash, Edit|Write|MultiEdit) are still there, in order, before the new one", () => {
    const s: any = withReadGuard(base, readable);
    expect(s.hooks.PreToolUse.slice(0, base.hooks.PreToolUse.length)).toEqual(base.hooks.PreToolUse);
    expect(s.hooks.PreToolUse).toHaveLength(base.hooks.PreToolUse.length + 1);
  });
  test("everything else is as it was; no `blockReadsOutsideWorkingDirectories` (it stalls claude, TASK-C-042); and still no sandbox", () => {
    const s: any = withReadGuard(base, readable);
    expect(s.permissions).toEqual(base.permissions);
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBeUndefined();
    expect(s.sandbox).toBeUndefined();
    expect(s.enabledPlugins).toEqual(base.enabledPlugins);
    expect(s.env).toEqual(base.env);
  });
  test("it stacks with withReadOnly (the Edit / Write denies and the guard hook sit side by side) and does not change the base", () => {
    const s: any = withReadGuard(withReadOnly(base, ["/work/spec"]), readable);
    expect(s.permissions.deny).toContain("Edit(//work/spec/**)");
    expect(s.hooks.PreToolUse.some((h: any) => h.matcher === "Read|Glob|Grep|Bash")).toBe(true);
    expect("sandbox" in s).toBe(false);
    expect(JSON.stringify(base)).toBe(before);
  });
  test("a readable folder with a space is single-quoted as part of the JSON argument", () => {
    const s: any = withReadGuard(base, ["/my work/app"]);
    const cmd: string = s.hooks.PreToolUse.find((h: any) => h.matcher === "Read|Glob|Grep|Bash").hooks[0].command;
    expect(cmd.endsWith(`'["/my work/app"]'`)).toBe(true);
  });
});
