// Dev script for TASK-C-030's Definition of Done (NOT part of the runner, never imported by it).
//   bun run src/runner/e2e/run.ts ac1       one real manual hop, the worker comments through MCP          (1 real hop)
//   bun run src/runner/e2e/run.ts ac6       one real hop that is told to `git push` in a sandbox repo      (1 real hop)
//   bun run src/runner/e2e/run.ts net       one real hop: `bun test` that does a fetch, inside the sandbox      (1 real hop)
//   bun run src/runner/e2e/run.ts restart   runner killed mid-hop, a second runner takes over               (fake claude, 0 real hops)
// It starts caw-back in-process on PORT (default 4530) with PGlite in memory and Team A's fake Blueprint, seeds a project, spawns the
// REAL runner (`bun run src/runner/main.ts`) as a child, starts a hop as the screen would, waits for it to end, prints what the store says.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app";
import { createBlueprint } from "../../blueprint/client";
import { createDb } from "../../db/client";
import { createFollower } from "../../follow/pull";
import { BP_PROJECT, fakeBlueprint } from "../../../test/helpers/fake-blueprint";

const scenario = process.argv[2] ?? "";
// not PORT: Bun loads caw-back/.env, which sets PORT for Team A's own server. Team C checks run on 4530 (SYSTEM-FACTS).
const PORT = Number(process.env.E2E_PORT || 4530);
const API = `http://127.0.0.1:${PORT}`;
const BACK = new URL("../../../", import.meta.url).pathname;
const WORKSPACE = process.env.CAW_WORKSPACE_ROOT || "";
if (!["ac1", "ac6", "net", "restart"].includes(scenario)) { console.error("usage: run.ts ac1|ac6|net|restart"); process.exit(1); }
if (!WORKSPACE) { console.error("CAW_WORKSPACE_ROOT is not set"); process.exit(1); }

const made: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
const say = (label: string, v: unknown) => console.log(`\n=== ${label}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);

async function call(method: string, path: string, body?: unknown, actor = "operator") {
  const res = await fetch(`${API}${path}`, { method, headers: { "x-caw-actor": actor, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json as any;
}

// ---- the API, in this process ----
const fake = fakeBlueprint();
const db = await createDb("pglite:memory");
const blueprint = createBlueprint(fake.url);
const app = createApp(db, { blueprint, follow: createFollower(db, blueprint) });
const server = Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: app.fetch });

// ---- seed ----
const root = tmp("caw-c030-root-");
if (scenario === "ac6" || scenario === "net") {
  // a sandbox repo whose only remote cannot leave the machine even if a push ran
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.name=c030", "-c", "user.email=c030@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "file:///nonexistent-caw-c030"], { cwd: root });
}
if (scenario === "net") {
  writeFileSync(join(root, "e2e-net.test.ts"), 'import { expect, test } from "bun:test";\ntest("reaches the network", async () => { const r = await fetch("https://example.com"); expect(r.status).toBe(200); });\n');
}
const project = await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT, version: 1 });
const worker = await call("POST", "/v1/workers", { name: "Blew", role: "BE", skills: ["role-be"], model: "haiku", effort: "low" });
await call("POST", `/v1/projects/${project.id}/chain/members`, { workerId: worker.id });
await call("PATCH", `/v1/projects/${project.id}/workspace`, { roots: [root] });
const todo = scenario === "net"
  ? "Run `bun test e2e-net.test.ts`, then run `git status`. Then add ONE comment (comment tool) with the result of each, one line each: did the test pass or fail and why, and did git status work."
  : scenario === "ac6"
  ? "Run exactly `git push origin HEAD` and nothing else; do not ask."
  : "Call card_context for this card, then add ONE comment (use the comment tool) saying: runner check ok. Do not change any file and do not change the card's status.";
const card = await call("POST", `/v1/projects/${project.id}/cards`, { title: "runner check", todo, anchor: { key: "STEP-004", version: 1 }, assigneeId: worker.id });
say("seed", { project: project.id, worker: worker.id, card: card.id, root });

// ---- the runner, as its own process ----
function startRunner(claudeBin?: string) {
  return Bun.spawn([process.execPath, "run", "src/runner/main.ts"], {
    cwd: BACK, stdout: "inherit", stderr: "inherit",
    env: { ...process.env, CAW_API_URL: API, CAW_WORKSPACE_ROOT: WORKSPACE, RUNNER_POLL_MS: "500", ...(claudeBin ? { CLAUDE_BIN: claudeBin } : {}) },
  });
}
const hops = async () => (await call("GET", `/v1/projects/${project.id}/hops?limit=20`)).hops as any[];
async function waitFor(what: string, ok: (h: any[]) => boolean, ms = 300_000) {
  const end = Date.now() + ms;
  for (;;) {
    const h = await hops();
    if (ok(h)) return h;
    if (Date.now() > end) throw new Error(`timeout waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const hopEvents = async () => ((await call("GET", `/v1/projects/${project.id}/events?after=0&limit=500`)).events as any[])
  .filter((e) => e.type.startsWith("hop.") || ["card.commented", "card.status_set", "card.handed_off", "card.question_opened"].includes(e.type)).map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, data: e.data }));

try {
  if (scenario === "ac1" || scenario === "ac6" || scenario === "net") {
    const runner = startRunner();
    const started = await call("POST", `/v1/projects/${project.id}/hops`, { cardId: card.id, workerId: worker.id }); // as the screen's "ให้ทำต่อ"
    say("hop started by the screen (no claim)", started);
    const done = await waitFor("the hop to end", (h) => h.length > 0 && h.every((x) => x.endedAt !== null));
    say("hop row (newest first)", done);
    say("hop + comment events", await hopEvents());
    if (scenario === "ac6" || scenario === "net") say("git remote -v of the sandbox repo", execFileSync("git", ["remote", "-v"], { cwd: root, encoding: "utf8" }));
    runner.kill();
    await runner.exited;
  } else {
    // restart: a "claude" that never finishes. Runner A claims the hop and starts it; A is stopped mid-hop; runner B takes over.
    const sleeper = join(tmp("caw-c030-bin-"), "fake-claude.sh");
    writeFileSync(sleeper, "#!/bin/sh\nexec sleep 120\n"); chmodSync(sleeper, 0o755);
    const quick = join(tmp("caw-c030-bin-"), "fake-claude-quick.sh");
    writeFileSync(quick, "#!/bin/sh\nexit 0\n"); chmodSync(quick, 0o755);
    const a = startRunner(sleeper);
    await call("POST", `/v1/projects/${project.id}/hops`, { cardId: card.id, workerId: worker.id });
    await waitFor("runner A to claim the hop", (h) => h.some((x) => x.claimedBy !== null && x.endedAt === null));
    say("before: runner A has claimed it, claude is running", await hops());
    a.kill(); // SIGTERM to its own handle: the runner stops its child and exits
    await a.exited;
    say("after A stopped: the hop is still 'running' in the store (nothing was lost, nothing was finished)", await hops());
    const b = startRunner(quick);
    const rows = await waitFor("runner B to interrupt the old hop and run a new one", (h) => h.length === 2 && h.every((x) => x.endedAt !== null));
    say("after runner B started: old hop interrupted, a new hop on the same card claimed by B (newest first)", rows);
    say("hop events — who each write was made as (the runner's writes are runner:<instance>)", (await hopEvents()).map((e) => `${e.seq} ${e.type} ${e.actor}`));
    b.kill();
    await b.exited;
  }
} finally {
  server.stop(true);
  fake.stop();
  for (const d of made) rmSync(d, { recursive: true, force: true });
}
