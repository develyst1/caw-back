// Runner configuration, read once at start. Refuses to start (one line, exit 1 in main.ts) rather than run unguarded:
// a worker without its block hooks is a worker that can `git push` (SPEC-C-003 R-1).
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

/** the workspace's three guard hooks, in the order run-settings.json runs them */
export const HOOKS = ["block-shell-edits.sh", "block-irreversible.sh", "block-kill-by-name.sh"] as const;

export type RunnerConfig = {
  apiUrl: string; pollMs: number; hopMaxMs: number; claudeBin: string; workspaceRoot: string;
  /** absolute paths of HOOKS under <workspaceRoot>/scripts/hooks, same order */
  hooks: string[];
  /** `host:port` of I-Space's own servers (REQ-113): a worker's command must never reach them. Optional so a config built by hand (tests) need not carry it; hop.ts reads it as `?? []`. */
  serverPorts?: string[];
  /** REQ-122 (SPEC-120 D3): an open worker is restarted after this many tasks, when its last task's context reaches this many input tokens, and ended after this many idle ms.
   *  Optional like `serverPorts`: a config built by hand (tests) need not carry them; the pool reads them as `?? default`. */
  workerMaxTasks?: number; workerMaxTokens?: number; workerIdleMs?: number;
};

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

const positive = (name: string, raw: string): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number, got "${raw}"`);
  return n;
};

/** `host:port` of a URL (port from the scheme when it has none: 80 / 443); null = not a URL we can read a host and port from. The raw value is never echoed — a URL can carry a password. */
export function hostPort(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
  return u.hostname === "" || port === "" ? null : `${u.hostname}:${port}`;
}

/** The servers a worker must never talk to (REQ-113): CAW's API (the runner's own `apiUrl`), Blueprint's API and web, and caw-front's default port (it has no variable). Each from its
 *  variable or its default; a value that is not a URL is skipped with one warning that names the VARIABLE only. Never throws. */
export function serverPortsOf(env: Env, apiUrl: string, warn: (line: string) => void): string[] {
  const out = new Set<string>(["127.0.0.1:3500"]);
  for (const [name, raw] of [["CAW_API_URL", apiUrl], ["BLUEPRINT_URL", env.BLUEPRINT_URL || "http://127.0.0.1:4200"], ["BLUEPRINT_WEB_URL", env.BLUEPRINT_WEB_URL || "http://127.0.0.1:3100"]] as const) {
    const hp = hostPort(raw);
    if (hp === null) warn(`${name} is not a URL (host and port) — it is not in the list of servers a worker may not reach`);
    else out.add(hp);
  }
  return [...out];
}

/** `||`, not `??`, for every default: Bun loads `.env`, and a blank `X=` line arrives as "". */
const canExecute = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };

export function loadConfig(env: Env = process.env, fileExists: (path: string) => boolean = existsSync, isExecutable: (path: string) => boolean = canExecute,
  warn: (line: string) => void = (line) => console.error(`runner: ${line}`)): RunnerConfig {
  const root = (env.CAW_WORKSPACE_ROOT || "").replace(/\/+$/, "");
  if (root === "") throw new ConfigError("CAW_WORKSPACE_ROOT is not set: the absolute path of ai-agent-workspace (the guard hooks and skills are read from it)");
  if (!isAbsolute(root)) throw new ConfigError(`CAW_WORKSPACE_ROOT must be an absolute path, got "${root}"`);

  const hooks = HOOKS.map((h) => `${root}/scripts/hooks/${h}`);
  for (const [i, path] of hooks.entries()) {
    if (!fileExists(path)) throw new ConfigError(`guard hook missing: ${HOOKS[i]} not found at ${path}`);
    if (!isExecutable(path)) throw new ConfigError(`guard hook not executable: ${HOOKS[i]} at ${path} (a non-executable hook exits 126, which is not a block)`);
  }

  const bin = env.CLAUDE_BIN || `${homedir()}/.local/bin/claude`;
  const apiUrl = env.CAW_API_URL || "http://127.0.0.1:4500";
  return {
    apiUrl,
    serverPorts: serverPortsOf(env, apiUrl, warn),
    pollMs: positive("RUNNER_POLL_MS", env.RUNNER_POLL_MS || "2000"),
    hopMaxMs: positive("RUNNER_HOP_MAX_MS", env.RUNNER_HOP_MAX_MS || "1200000"),
    workerMaxTasks: positive("RUNNER_WORKER_MAX_TASKS", env.RUNNER_WORKER_MAX_TASKS || "5"),
    workerMaxTokens: positive("RUNNER_WORKER_MAX_TOKENS", env.RUNNER_WORKER_MAX_TOKENS || "150000"),
    workerIdleMs: positive("RUNNER_WORKER_IDLE_MS", env.RUNNER_WORKER_IDLE_MS || "1800000"),
    claudeBin: bin.startsWith("~/") ? `${homedir()}${bin.slice(1)}` : bin,
    workspaceRoot: root,
    hooks,
  };
}
