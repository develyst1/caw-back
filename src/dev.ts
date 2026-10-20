// `bun run dev`: the API and the runner in one terminal (SPEC-A-009 § R1a + Revision 3, REQ-015 R1, D-103). Two child processes with the same environment,
// every line prefixed `[api]` / `[runner]`. Ctrl+C (SIGINT) and SIGTERM stop what dev.ts started.
//  · Before it starts the API it asks `GET http://127.0.0.1:$PORT/health` (1 s). If a CAW API already answers ({ ok: true }), it prints
//    `[dev] an API already answers on :<port> — starting the runner only`, starts ONLY the runner, and exits when the runner exits (with its code) —
//    the same command is then safe to run beside an API somebody started (the screen's "team not running" command is `bun run runner`, the warm case).
//  · Otherwise it starts both. If the API child then exits within 5 s of its start (a race, or a non-CAW program on the port) the RUNNER IS KEPT:
//    `[api] could not start (port in use?) — runner kept`. Later, if the runner stops too, dev.ts exits with the runner's code. A later API exit (after
//    those 5 s) stops the runner and exits with the API's code.
//  · If the runner exits (say CAW_WORKSPACE_ROOT is not set — the runner says so itself), its last line is printed as `[runner] stopped: <line>` and a
//    running API is KEPT, so the screen can say the team is down. No restarts: a crash loop on a missing setting helps nobody.
// `bun run api` is the API alone; `bun run runner` is the runner alone. The entry files can be replaced for tests (CAW_DEV_API_ENTRY / CAW_DEV_RUNNER_ENTRY),
// and the 5-s window too (CAW_DEV_API_EARLY_MS) — nothing else changes how they are started.
import type { Subprocess } from "bun";

const apiEntry = process.env.CAW_DEV_API_ENTRY || `${import.meta.dir}/index.ts`;
const runnerEntry = process.env.CAW_DEV_RUNNER_ENTRY || `${import.meta.dir}/runner/main.ts`;
const port = process.env.PORT || "4500";
const earlyMs = Number(process.env.CAW_DEV_API_EARLY_MS || 5000);

type Child = { name: "api" | "runner"; proc: Subprocess<"ignore", "pipe", "pipe">; last: string; drained: Promise<void>; startedAt: number };

/** one stream → prefixed lines; the last non-blank line is remembered for the "stopped" message */
async function pump(child: { name: string; last: string }, stream: ReadableStream<Uint8Array>, write: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = (line: string) => { if (line.trim() !== "") child.last = line; write(`[${child.name}] ${line}`); };
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop()!;
    parts.forEach(emit);
  }
  if (buffer !== "") emit(buffer);
}

function start(name: Child["name"], entry: string): Child {
  const proc = Bun.spawn([process.execPath, entry], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const child = { name, proc, last: "", drained: Promise.resolve(), startedAt: Date.now() } as Child;
  child.drained = Promise.all([pump(child, proc.stdout, console.log), pump(child, proc.stderr, console.error)]).then(() => undefined);
  return child;
}

/** a CAW API answers on our port: `/health` → 200 { ok: true }. Any other answer (or none) is not one — a non-CAW program on the port is the API child's problem to report. */
async function apiAlreadyAnswers(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

const already = await apiAlreadyAnswers();
if (already) console.log(`[dev] an API already answers on :${port} — starting the runner only`);
const api: Child | null = already ? null : start("api", apiEntry);
const runner = start("runner", runnerEntry);
const children = [api, runner].filter((c): c is Child => c !== null);
let stopping = false;
let apiAlive = api !== null;

async function stopAll(code: number): Promise<never> {
  stopping = true;
  for (const c of children) if (c.proc.exitCode === null) c.proc.kill("SIGTERM");
  await Promise.race([Promise.all(children.map((c) => c.proc.exited)), new Promise((r) => setTimeout(r, 5000))]);
  for (const c of children) if (c.proc.exitCode === null) c.proc.kill("SIGKILL"); // it ignored SIGTERM for 5 s
  process.exit(code);
}

process.on("SIGINT", () => void stopAll(0));
process.on("SIGTERM", () => void stopAll(0));

if (api) {
  void api.proc.exited.then(async (code) => {
    if (stopping) return;
    await api.drained;
    apiAlive = false;
    if (Date.now() - api.startedAt < earlyMs) { // it never really started: a port race, or something that is not CAW on the port — the runner is not its hostage
      console.log("[api] could not start (port in use?) — runner kept");
      return;
    }
    console.log(`[api] exited with code ${code}`);
    await stopAll(code === 0 ? 0 : code || 1); // the API's own code (a signal death has none → 1)
  });
}

void runner.proc.exited.then(async (code) => {
  if (stopping) return;
  await runner.drained; // its last line is only known once the pipes are empty
  console.log(`[runner] stopped: ${runner.last || "(it printed nothing)"}`);
  if (!apiAlive) process.exit(code === 0 ? 0 : code || 1); // nothing of ours is left running: exit with the runner's code
});
