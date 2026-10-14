// The per-hop trace (TASK-C-036): every hop's `stream-json` kept as a file, so a hop that ended empty can be read afterwards.
// It stays on this Mac, is never sent anywhere, and goes through redact.ts line by line.
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./redact";

export const TRACE_KEEP = 500;

/** `||`, not `??`: Bun loads `.env`, and a blank `RUNNER_TRACE_DIR=` line arrives as "". */
export const traceDirFrom = (env: Record<string, string | undefined>): string => env.RUNNER_TRACE_DIR || join(homedir(), ".caw", "traces");

/** Written atomically (temp file, then rename), 0600 in a 0700 folder. Returns the path. */
export function writeTrace(dir: string, hopId: string, lines: readonly string[]): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${hopId.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, lines.map((l) => `${redact(l)}\n`).join(""), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Keep the newest `keep` trace files (by modified time); older ones are deleted. Other files in the folder are not touched. */
export function rotateTraces(dir: string, keep: number, log: (line: string) => void): void {
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`could not read the trace folder ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const aged = names.flatMap((n) => { try { return [{ n, t: statSync(join(dir, n)).mtimeMs }]; } catch { return []; } }).sort((a, b) => b.t - a.t);
  for (const { n } of aged.slice(keep)) {
    try { rmSync(join(dir, n), { force: true }); } catch (e) { log(`could not delete the old trace ${n}: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

/** "tools: chat_context ×3, locate ×0, reply ×0 · turns 14" — which tools the model called, how often, in how many turns.
 *  `expect` are tools that belong to this hop: they are listed with ×0 when never called, because their absence is the finding. */
export function toolSummary(lines: Iterable<string>, expect: readonly string[]): string {
  const counts = new Map<string, number>();
  const calls = new Set<string>();
  const turns = new Set<string>();
  for (const line of lines) {
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (m?.type !== "assistant") continue;
    if (typeof m.message?.id === "string") turns.add(m.message.id);
    for (const c of m.message?.content ?? []) {
      if (c?.type !== "tool_use" || calls.has(c.id)) continue; // one message can appear on several lines
      calls.add(c.id);
      const name = String(c.name).replace(/^mcp__caw__/, "");
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  for (const e of expect) if (!counts.has(e)) counts.set(e, 0);
  const used = [...counts].map(([k, v]) => `${k} ×${v}`).join(", ");
  return `tools: ${used === "" ? "none" : used} · turns ${turns.size}`;
}
