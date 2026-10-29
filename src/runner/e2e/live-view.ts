// Dev script for REQ-104's checks (SPEC-103 § Dev script) — NOT part of the runner. It starts caw-back as a CHILD process (so it can be stopped and started again),
// seeds one project / worker / card, starts the REAL runner with a STUB `claude` (ticker-claude.ts) and starts one manual hop. 0 real Claude usage by default:
//   CLAUDE_BIN is written below, never read from the environment or from caw-back/.env. A different CLAUDE_BIN in the environment is ignored.
//   Start it as `bun --no-env-file run …` (the owner's caw-back/.env sets CAW_WORKSPACE_ROOT and a remote DATABASE_URL); it starts BOTH children with
//   `--no-env-file` too and gives them DATABASE_URL = a local pglite folder, explicitly. It refuses to start if the claude it would hand the runner is not there.
//   CAW_WORKSPACE_ROOT=<ai-agent-workspace — where scripts/hooks are> [LIVE_VIEW_SECRET=…] [TICKS=60] [E2E_PORT=4530] [LIVE_VIEW_API_DOWN_AT=<s> LIVE_VIEW_API_DOWN_FOR=<s>] bun --no-env-file run src/runner/e2e/live-view.ts
//  · LIVE_VIEW_REAL=1: the ONE allowed live run (owner 13:01, SPEC-103 G1): the runner gets the REAL claude (~/.local/bin/claude) and the card asks a harmless thing of a
//    haiku/low worker. The stub is not used. Everything else about the script is the same.
//  · the stub prints one line a second for TICKS; tick 5 carries `sk-test-…` and the value of LIVE_VIEW_SECRET (written into the stub's wrapper: its env is cut)
//  · LIVE_VIEW_SECRET is also in the RUNNER's env, where `secretValues` finds it (the name matches SECRET)
//  · DOWN_AT / DOWN_FOR: that many seconds after the hop starts the API child is stopped, and started again on the same port and database after the pause (AC-6)
// It prints what to run for the screen (caw-front) and the hop's output URL. Ctrl+C stops everything it started, by pid.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BP_PROJECT, fakeBlueprint } from "../../../test/helpers/fake-blueprint";

const PORT = Number(process.env.E2E_PORT || 4530); // not PORT: Bun loads caw-back/.env, which may set PORT for the real server
const API = `http://127.0.0.1:${PORT}`;
const BACK = new URL("../../../", import.meta.url).pathname;
const WORKSPACE = process.env.CAW_WORKSPACE_ROOT || "";
if (!WORKSPACE) { console.error("CAW_WORKSPACE_ROOT is not set (the runner needs it for its guard hooks)"); process.exit(1); }
const TICKS = Number(process.env.TICKS || 60);
const SECRET = process.env.LIVE_VIEW_SECRET ?? "";
const DOWN_AT = process.env.LIVE_VIEW_API_DOWN_AT ? Number(process.env.LIVE_VIEW_API_DOWN_AT) : null;
const DOWN_FOR = Number(process.env.LIVE_VIEW_API_DOWN_FOR || 30);
const REAL = process.env.LIVE_VIEW_REAL === "1";
if (process.env.CLAUDE_BIN) console.log(`note: CLAUDE_BIN in the environment is ignored; the runner gets ${REAL ? "the real claude (LIVE_VIEW_REAL=1)" : "the stub"}`);

const made: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const say = (label: string, v: unknown) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)} s] ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
async function call(method: string, path: string, body?: unknown, actor = "operator") {
  const res = await fetch(`${API}${path}`, { method, headers: { "x-caw-actor": actor, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json as any;
}

// The runner reads the worker's skills from <root>/.claude/skills/<name>/SKILL.md and its guard hooks from <root>/scripts/hooks, and a worker needs at least one skill
// (the API refuses none). The real workspace has no such skill folder, so the script makes its OWN run root: a stub `role-be` skill, and `scripts` linked to the real
// workspace's, so the real guard hooks are the ones that run. CAW_WORKSPACE_ROOT (the real workspace) is only where those hooks come from.
if (!existsSync(join(WORKSPACE, "scripts", "hooks"))) { console.error(`CAW_WORKSPACE_ROOT has no scripts/hooks (the guard hooks): ${WORKSPACE}`); process.exit(1); }
const fake = fakeBlueprint();
const RUN_ROOT = tmp("caw-live-ws-");
mkdirSync(join(RUN_ROOT, ".claude", "skills", "role-be"), { recursive: true });
writeFileSync(join(RUN_ROOT, ".claude", "skills", "role-be", "SKILL.md"), "A stand-in skill for the live-view check. Do the card, and nothing more.\n");
symlinkSync(join(WORKSPACE, "scripts"), join(RUN_ROOT, "scripts"));
const root = join(RUN_ROOT, "work"); // the project's folder is under the run root: hop.ts refuses any folder outside CAW_WORKSPACE_ROOT (TASK-112)
mkdirSync(root);
const dbDir = join(tmp("caw-live-db-"), "pg");

// the stub: a shell wrapper that carries TICKS and the secret in its own text (the runner cuts the child's env to PATH HOME …)
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const CLAUDE_STUB = join(tmp("caw-live-bin-"), "ticker-claude.sh");
writeFileSync(CLAUDE_STUB, `#!/bin/sh\nTICKS=${TICKS} LIVE_VIEW_SECRET=${shq(SECRET)} exec "${process.execPath}" run "${new URL("./ticker-claude.ts", import.meta.url).pathname}" "$@"\n`, { mode: 0o700 });
chmodSync(CLAUDE_STUB, 0o700);
// the ONE claude the runner is given: written here, never from env or .env; it must exist or nothing starts
const CLAUDE_FOR_RUNNER = REAL ? join(homedir(), ".local", "bin", "claude") : CLAUDE_STUB;
if (!existsSync(CLAUDE_FOR_RUNNER)) { console.error(`the claude for the runner is not there: ${CLAUDE_FOR_RUNNER}`); process.exit(1); }
console.log(`CLAUDE_BIN given to the runner: ${CLAUDE_FOR_RUNNER}  (${REAL ? "REAL claude — LIVE_VIEW_REAL=1" : "STUB wrapper around ticker-claude.ts"})`);

const startApi = () => Bun.spawn([process.execPath, "--no-env-file", "run", "src/index.ts"], {
  cwd: BACK, stdout: "inherit", stderr: "inherit",
  env: { ...process.env, PORT: String(PORT), DATABASE_URL: `pglite:file:${dbDir}`, CAW_POLL_MS: "0", BLUEPRINT_URL: fake.url },
});
async function waitUp(ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(`${API}/health`)).ok) return; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error("the API did not come up");
    await sleep(200);
  }
}

let api: ReturnType<typeof startApi> | null = null;
let runner: ReturnType<typeof Bun.spawn> | null = null;
let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  runner?.kill();
  api?.kill();
  await Promise.all([runner?.exited, api?.exited]);
  fake.stop();
  for (const d of made) rmSync(d, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void cleanup().then(() => process.exit(0)); });

try {
  api = startApi();
  await waitUp();
  say("API up", `${API} (pid ${api.pid}, database ${dbDir})`);

  const project = await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT, version: 1 });
  const worker = await call("POST", "/v1/workers", { name: "Blew", role: "BE", skills: ["role-be"], model: "haiku", effort: "low" });
  await call("POST", `/v1/projects/${project.id}/chain/members`, { workerId: worker.id });
  await call("PATCH", `/v1/projects/${project.id}/workspace`, { roots: [root] });
  // LIVE_VIEW_TODO (optional) replaces the card's text — e.g. the TASK-118 probe asks a real worker to run three commands and report
  const todo = process.env.LIVE_VIEW_TODO || (REAL
    ? "Look at the files in your folder (there may be none). Then leave exactly one comment on this card, with the comment tool, saying in one short sentence what you found. Do nothing else."
    : "FAKE:");
  const card = await call("POST", `/v1/projects/${project.id}/cards`, { title: "live view", todo, anchor: { key: "STEP-004", version: 1 }, assigneeId: worker.id });

  // CLAUDE_BIN last, explicit: the stub, or — only with LIVE_VIEW_REAL=1 — the real claude (SPEC-103 G1)
  runner = Bun.spawn([process.execPath, "--no-env-file", "run", "src/runner/main.ts"], {
    cwd: BACK, stdout: "inherit", stderr: "inherit",
    env: { ...process.env, CAW_API_URL: API, CAW_WORKSPACE_ROOT: RUN_ROOT, RUNNER_POLL_MS: "300", CLAUDE_BIN: CLAUDE_FOR_RUNNER },
  });
  say("runner started", `pid ${runner.pid}, claude = ${CLAUDE_FOR_RUNNER}${REAL ? " (REAL)" : " (stub)"}`);
  for (let i = 0; i < 100 && !(await call("GET", "/v1/team-status")).running; i++) await sleep(200);

  const hop = await call("POST", `/v1/projects/${project.id}/hops`, { cardId: card.id, workerId: worker.id }); // as the screen's "ให้ทำต่อ"
  const hopStart = Date.now();
  say("hop started", hop.id);
  console.log(`\ncaw-front: CAW_API_URL=${API} bun run dev     then open  http://localhost:3500/p/${project.id}`);
  console.log(`output:    curl -s ${API}/v1/hops/${hop.id}/output | head -c 600\n`);

  let downDone = DOWN_AT === null;
  const deadline = Date.now() + (REAL ? 15 * 60 : TICKS + 90 + (DOWN_AT === null ? 0 : DOWN_FOR)) * 1000;
  for (;;) {
    if (!downDone && Date.now() - hopStart >= DOWN_AT! * 1000) {
      downDone = true;
      say("API DOWN", `stopping pid ${api!.pid} for ${DOWN_FOR} s`);
      api!.kill();
      await api!.exited;
      await sleep(DOWN_FOR * 1000);
      api = startApi();
      await waitUp();
      say("API back", `pid ${api.pid}`);
    }
    const h = ((await call("GET", `/v1/projects/${project.id}/hops?limit=5`)).hops as any[]).find((x) => x.id === hop.id);
    if (h?.endedAt) { say("hop ended", { outcome: h.outcome, note: h.note }); break; }
    if (Date.now() > deadline) throw new Error("the hop did not end in time");
    await sleep(500);
  }

  const out = await call("GET", `/v1/hops/${hop.id}/output?limit=1000`);
  const raw = JSON.stringify(out);
  say("output", { entries: out.entries.length, more: out.more, gaps: out.entries.filter((e: any) => e.kind === "gap"), tick5: out.entries.find((e: any) => /^tick 5 /.test(e.text))?.text ?? null });
  say("secret value in the stored output?", SECRET === "" ? "(LIVE_VIEW_SECRET not set)" : raw.includes(SECRET) ? "YES — LEAK" : "no");
  say("sk-test key in the stored output?", raw.includes("sk-test-abcdefghijklmnopqrstuvwx") ? "YES — LEAK" : "no");
  console.log("\nThe API is still up for reading: Ctrl+C to stop everything.");
  await new Promise(() => {});
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  await cleanup();
  process.exit(1);
}
