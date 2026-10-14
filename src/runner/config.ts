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
};

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

const positive = (name: string, raw: string): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number, got "${raw}"`);
  return n;
};

/** `||`, not `??`, for every default: Bun loads `.env`, and a blank `X=` line arrives as "". */
const canExecute = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };

export function loadConfig(env: Env = process.env, fileExists: (path: string) => boolean = existsSync, isExecutable: (path: string) => boolean = canExecute): RunnerConfig {
  const root = (env.CAW_WORKSPACE_ROOT || "").replace(/\/+$/, "");
  if (root === "") throw new ConfigError("CAW_WORKSPACE_ROOT is not set: the absolute path of ai-agent-workspace (the guard hooks and skills are read from it)");
  if (!isAbsolute(root)) throw new ConfigError(`CAW_WORKSPACE_ROOT must be an absolute path, got "${root}"`);

  const hooks = HOOKS.map((h) => `${root}/scripts/hooks/${h}`);
  for (const [i, path] of hooks.entries()) {
    if (!fileExists(path)) throw new ConfigError(`guard hook missing: ${HOOKS[i]} not found at ${path}`);
    if (!isExecutable(path)) throw new ConfigError(`guard hook not executable: ${HOOKS[i]} at ${path} (a non-executable hook exits 126, which is not a block)`);
  }

  const bin = env.CLAUDE_BIN || `${homedir()}/.local/bin/claude`;
  return {
    apiUrl: env.CAW_API_URL || "http://127.0.0.1:4500",
    pollMs: positive("RUNNER_POLL_MS", env.RUNNER_POLL_MS || "2000"),
    hopMaxMs: positive("RUNNER_HOP_MAX_MS", env.RUNNER_HOP_MAX_MS || "1200000"),
    claudeBin: bin.startsWith("~/") ? `${homedir()}${bin.slice(1)}` : bin,
    workspaceRoot: root,
    hooks,
  };
}
