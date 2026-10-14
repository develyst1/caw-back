// The generated worker settings (SPEC-C-003 § 2): written per runner start into a temp folder, never into a repo, never committed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Read-only and test commands only (REQ-012 "no git writes … including workers"). No curl / wget / nc / ssh / scp and no
 *  generic `node *` / `python3 *` / `bun *`: with the web tools gone the model reached for curl (TASK-C-029 § 5, R-4). */
export const WORKER_ALLOW = [
  "Bash(git status *)", "Bash(git log *)", "Bash(git diff *)", "Bash(git show *)",
  "Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(grep *)", "Bash(wc *)",
  "Bash(bun test *)", "Bash(bun run typecheck)",
  // CAW's own MCP tools (the server is named `caw` in the per-hop MCP config). `-p` cannot ask, so an unlisted MCP tool is DENIED —
  // the first real hop was stopped on its own card_context call. By name, not `mcp__caw`: `my_cards` is not part of a hop.
  "mcp__caw__card_context", "mcp__caw__comment", "mcp__caw__hand_off", "mcp__caw__set_status", "mcp__caw__ask_operator",
  // the entry worker's chat hop (REQ-013, contract v1.4)
  "mcp__caw__chat_context", "mcp__caw__locate", "mcp__caw__propose_cards", "mcp__caw__send_amendment", "mcp__caw__reply",
] as const;

/** A deny rule beats any allow, so a broad allow added by mistake still cannot open the network. Also: `find … -exec` runs anything
 *  (so `find` itself is not allowed at all, and these forms are denied in case it ever is), and `git diff --output=<path>` writes any file. */
const DENY = [
  ...["curl", "wget", "nc", "ssh", "scp"].map((t) => `Bash(${t} *)`),
  "Bash(find * -exec*)", "Bash(find * -execdir*)", "Bash(git diff --output*)",
];

/** single-quote a hook path only when the shell would split it */
const shellWord = (p: string) => (/^[A-Za-z0-9_\/.\-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

/** @param hooks the three absolute hook paths in HOOKS order: [block-shell-edits, block-irreversible, block-kill-by-name] */
export function buildSettings(hooks: readonly string[]): object {
  if (hooks.length !== 3 || hooks.some((h) => !h.startsWith("/"))) throw new Error("buildSettings needs the three guard hooks as absolute paths");
  const run = (p: string) => ({ type: "command", command: shellWord(p) });
  return {
    // R-5 (i): a hop gets its role skill and CAW's MCP server, not the plugins that happen to be loaded. These three showed up in every real hop's `init`
    // although `--setting-sources project` dropped the operator's own; telemetry says they come from the `builtin` marketplace ("name@marketplace").
    enabledPlugins: { "cc-plugin-agents-md@builtin": false, "cc-plugin-telemetry@builtin": false, "cc-plugin-plugin-authoring@builtin": false },
    // Tool search defers MCP tools behind a `ToolSearch` turn, and a haiku hop was seen to load them and then never call them (TASK-C-036 trace).
    // `false` = "All MCP tools loaded upfront, no deferral" (code.claude.com/docs/en/mcp, "Configure tool search").
    env: { ENABLE_TOOL_SEARCH: "false" },
    permissions: { allow: [...WORKER_ALLOW], deny: DENY },
    // R-4: shell commands run in Claude Code's own OS sandbox with no network ("allowedDomains" starts empty; "strictAllowlist" denies instead of
    // asking). It covers shell commands only — the web tools are --disallowedTools, MCP and hooks run outside it. Keys: code.claude.com/docs/en/sandboxing.
    // "failIfUnavailable" + "allowUnsandboxedCommands: false": no silent fallback to unsandboxed, and the model cannot retry outside it.
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true } },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: hooks.map(run) },
        { matcher: "Edit|Write|MultiEdit", hooks: [run(hooks[1]!)] },
      ],
    },
  };
}

export function writeSettings(dir: string, hooks: readonly string[]): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "settings.json");
  writeFileSync(file, `${JSON.stringify(buildSettings(hooks), null, 2)}\n`, { mode: 0o600 });
  return file;
}
