// The generated worker settings (SPEC-C-003 § 2): written per runner start into a temp folder, never into a repo, never committed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `Bash` is allowed as a whole (SPEC-108 D1; owner decision REQ-111 Q5 = A, 2026-10-29: "allow all Bash, our hook decides"). WHAT a worker may run is decided by our hook
 *  (read-guard.ts → bash-policy.ts), not by claude's allow-list, so a refusal comes with OUR reason and the policy is unit-tested without a real claude. The three workspace guard
 *  hooks (git writes, irreversible commands, kill by name) still run first on every Bash call, and the denies below still beat the allow. */
export const WORKER_ALLOW = [
  "Bash",
  // CAW's own MCP tools (the server is named `caw` in the per-hop MCP config). `-p` cannot ask, so an unlisted MCP tool is DENIED —
  // the first real hop was stopped on its own card_context call. By name, not `mcp__caw`: `my_cards` is not part of a hop.
  "mcp__caw__card_context", "mcp__caw__comment", "mcp__caw__hand_off", "mcp__caw__set_status", "mcp__caw__ask_operator",
  // the entry worker's chat hop (REQ-013, contract v1.4)
  "mcp__caw__chat_context", "mcp__caw__locate", "mcp__caw__propose_cards", "mcp__caw__send_amendment", "mcp__caw__reply",
  // the setup step: the entry worker saves the code map (TASK-C-041, contract v1.16). Unlisted, `-p` would deny the call.
  "mcp__caw__save_code_map",
] as const;

/** A deny rule beats any allow, so with `Bash` allowed as a whole these are a second line behind the hook's policy: the programs that only ever reach out (`nc ssh scp`), `find … -exec`
 *  (runs anything) and `git diff --output=<path>` (writes any file). `curl` / `wget` are NOT denied here: the hook lets them talk to 127.0.0.1 only, and a deny would beat that. */
const DENY = [
  ...["nc", "ssh", "scp"].map((t) => `Bash(${t} *)`),
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
    // No Claude Bash sandbox (owner Nichaphon 13:41 and 14:03, SPEC-103 § "No Bash sandbox"): it needs socat/bubblewrap on the host. What keeps a hop in its folders instead is the
    // read-guard hook on Read|Glob|Grep|Bash (withReadGuard; for Bash it runs bash-policy.ts), the denies above (nc / ssh / scp, find -exec, git diff --output) and hop.ts's folder confinement.
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: hooks.map(run) },
        { matcher: "Edit|Write|MultiEdit", hooks: [run(hooks[1]!)] },
      ],
    },
  };
}

/** The base settings plus, for each READ-ONLY folder (D-100): Edit and Write denied (permission paths use `//` for an absolute path). A Bash command that writes there is
 *  refused by the hook (bash-policy.ts, `read_only`), which gets these folders as its optional 2nd argument (withReadGuard). Pure: the base is not changed; with no read-only folder it comes back as it is. */
export function withReadOnly(base: any, readOnly: readonly string[]): any {
  if (readOnly.length === 0) return base;
  const dirs = readOnly.map((d) => d.replace(/\/+$/, ""));
  return {
    ...base,
    permissions: { ...base.permissions, deny: [...(base.permissions?.deny ?? []), ...dirs.flatMap((d) => [`Edit(/${d}/**)`, `Write(/${d}/**)`])] },
  };
}

/** the guard script the file-tool hook runs (an absolute path: the hook's cwd is the worker's folder) */
export const READ_GUARD_SCRIPT = fileURLToPath(new URL("./read-guard.ts", import.meta.url));

/** The read fence of EVERY hop (TASK-C-042 Part A, UP-3 — client data must never reach the model). One PreToolUse hook (read-guard.ts) on Read | Glob | Grep | Bash with the
 *  readable folders as its ONE argument. The key `permissions.blockReadsOutsideWorkingDirectories` would do it but stalls claude at start-up, and the Bash sandbox's
 *  `denyRead` is gone with the sandbox (owner 13:41), so for Bash the hook judges the command's words itself and fails closed (read-guard.ts).
 *  `readable` = the project's roots + the hop's private folder. Pure: the base is not changed. */
export function withReadGuard(base: any, readable: readonly string[], readOnly: readonly string[] = []): any {
  // the read-only folders are the hook's optional 2nd argument (SPEC-108 D3): only a Bash command that WRITES is judged against them; with none, the one-argument form is unchanged
  const second = readOnly.length > 0 ? ` ${shellWord(JSON.stringify(readOnly))}` : "";
  const hook = { matcher: "Read|Glob|Grep|Bash", hooks: [{ type: "command", command: `${shellWord(process.execPath)} ${shellWord(READ_GUARD_SCRIPT)} ${shellWord(JSON.stringify(readable))}${second}` }] };
  return {
    ...base,
    hooks: { ...base.hooks, PreToolUse: [...(base.hooks?.PreToolUse ?? []), hook] },
  };
}

export function writeSettings(dir: string, hooks: readonly string[]): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "settings.json");
  writeFileSync(file, `${JSON.stringify(buildSettings(hooks), null, 2)}\n`, { mode: 0o600 });
  return file;
}
