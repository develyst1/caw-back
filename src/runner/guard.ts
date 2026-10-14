// Prove the guard hooks work BEFORE the first hop. A hook that merely exists is not a guard: Claude Code treats any exit code but 2
// as "no block", and all three hooks `exit 0` silently when `jq` is missing (block-kill-by-name also needs `perl`). So at start each hook
// is run once on a payload it exists to stop, and must exit 2; otherwise the runner refuses to start.
import { basename } from "node:path";

export class GuardError extends Error {}

const bash = (command: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

/** one payload per hook, keyed by file name; the commands are only ever read from stdin by the hook, never run */
export const PROBES: Record<string, string> = {
  "block-shell-edits.sh": bash("sed -i s/a/b/ somefile"),
  "block-irreversible.sh": bash("git push origin HEAD"),
  "block-kill-by-name.sh": bash("pkill node"),
};

type Run = (hookPath: string, stdin: string) => Promise<number>;

const spawnProbe: Run = async (path, stdin) => {
  const p = Bun.spawn([path], { stdin: new TextEncoder().encode(stdin), stdout: "ignore", stderr: "ignore" });
  return await p.exited;
};

export async function probeHooks(hooks: readonly string[], run: Run = spawnProbe): Promise<void> {
  for (const path of hooks) {
    const name = basename(path);
    const payload = PROBES[name];
    if (payload === undefined) throw new GuardError(`no probe known for guard hook ${name}`);
    let code: number;
    try { code = await run(path, payload); } catch (e) { throw new GuardError(`guard hook ${name} could not be run: ${e instanceof Error ? e.message : String(e)}`); }
    if (code !== 2) throw new GuardError(`guard hook ${name} did not block its probe (exit ${code}, wanted 2) — is jq (and perl) installed and on PATH?`);
  }
}
