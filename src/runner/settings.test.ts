import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOKS } from "./config";
import { WORKER_ALLOW, buildSettings, writeSettings } from "./settings";

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

  test("the Bash sandbox is on, cannot be switched off by the model, and has no network domain allowed (R-4; keys from the sandboxing docs)", () => {
    expect(s.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
    });
  });

  test("the three built-in plugins every hop loaded are switched OFF (R-5; TASK-C-035 item 2 (i))", () => {
    expect(s.enabledPlugins).toEqual({ "cc-plugin-agents-md@builtin": false, "cc-plugin-telemetry@builtin": false, "cc-plugin-plugin-authoring@builtin": false });
    expect(s.env).toEqual({ ENABLE_TOOL_SEARCH: "false" }); // MCP tools loaded upfront, no ToolSearch turn (TASK-C-036; code.claude.com/docs/en/mcp, Configure tool search)
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
