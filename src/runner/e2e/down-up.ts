// Dev script for TASK-C-040's "answered later" proof (REQ-015 AC-1, second half) — NOT part of the runner. Real runner process, real HTTP API on E2E_PORT
// (default 4530, PGlite in memory, Team A's fake Blueprint) and a FAKE `claude` (fake-claude.ts): 0 real Claude usage.
//   CAW_WORKSPACE_ROOT=<ai-agent-workspace> bun run src/runner/e2e/down-up.ts
//  1. with NO runner running, the operator posts a chat message           2. GET /v1/team-status → running: false
//  3. the runner is started                                               4. within 15 s: running: true AND the message has a reply (replyHopId)
//  5. SIGTERM (Ctrl+C) → running: false on the next read
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app";
import { createBlueprint } from "../../blueprint/client";
import { createDb } from "../../db/client";
import { createFollower } from "../../follow/pull";
import { BP_PROJECT, fakeBlueprint } from "../../../test/helpers/fake-blueprint";

const PORT = Number(process.env.E2E_PORT || 4530);
const API = `http://127.0.0.1:${PORT}`;
const BACK = new URL("../../../", import.meta.url).pathname;
const WORKSPACE = process.env.CAW_WORKSPACE_ROOT || "";
if (!WORKSPACE) { console.error("CAW_WORKSPACE_ROOT is not set"); process.exit(1); }

const made: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function call(method: string, path: string, body?: unknown, actor = "operator") {
  const res = await fetch(`${API}${path}`, { method, headers: { "x-caw-actor": actor, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json as any;
}

const fake = fakeBlueprint();
const db = await createDb("pglite:memory");
const blueprint = createBlueprint(fake.url);
const server = Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: createApp(db, { blueprint, follow: createFollower(db, blueprint) }).fetch });

const root = tmp("caw-c040-root-");
const bin = join(tmp("caw-c040-bin-"), "fake-claude.sh");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" run "${new URL("./fake-claude.ts", import.meta.url).pathname}" "$@"\n`);
chmodSync(bin, 0o755);

const T0 = Date.now();
const at = () => `${((Date.now() - T0) / 1000).toFixed(1)} s`;
const say = (label: string, v: unknown) => console.log(`[${at()}] ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const status = async () => (await call("GET", "/v1/team-status")) as { running: boolean; runnerName: string | null; lastSeenAt: string | null; startCommand: string };

let runner: ReturnType<typeof Bun.spawn> | null = null;
const out: any = {};
try {
  const project = await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT, version: 1 });
  const worker = await call("POST", "/v1/workers", { name: "Blew", role: "BE", skills: ["role-be"], model: "haiku", effort: "low" });
  await call("POST", `/v1/projects/${project.id}/chain/members`, { workerId: worker.id });
  await call("PATCH", `/v1/projects/${project.id}/workspace`, { roots: [root] });
  await call("PUT", `/v1/projects/${project.id}/chain/entry`, { workerId: worker.id });
  const P = `/v1/projects/${project.id}`;

  // 1 + 2: no runner yet
  const msg = await call("POST", `${P}/chat`, { text: "ช่วยดูโปรเจคนี้หน่อย (ส่งตอนที่ทีมยังไม่ทำงาน)" });
  const before = await status();
  say("no runner — GET /v1/team-status", before);
  out.beforeRunning = before.running;
  await sleep(1500);
  const stillNoReply = (await call("GET", `${P}/chat`)).messages.find((m: any) => m.id === msg.id).replyHopId;
  say("1.5 s later, the message has a reply?", stillNoReply !== null);
  out.noReplyWhileDown = stillNoReply === null;

  // 3: start the runner
  const startedAt = Date.now();
  runner = Bun.spawn([process.execPath, "run", "src/runner/main.ts"], {
    cwd: BACK, stdout: "inherit", stderr: "inherit",
    env: { ...process.env, CAW_API_URL: API, CAW_WORKSPACE_ROOT: WORKSPACE, RUNNER_POLL_MS: "300", CLAUDE_BIN: bin },
  });
  say("runner started", `pid ${runner.pid}`);

  // 4: within 15 s: running and replied
  let runningAt: number | null = null, repliedAt: number | null = null, replyHopId: string | null = null;
  while (Date.now() - startedAt < 15_000 && (runningAt === null || repliedAt === null)) {
    if (runningAt === null && (await status()).running) runningAt = Date.now() - startedAt;
    if (repliedAt === null) {
      const m = (await call("GET", `${P}/chat`)).messages.find((x: any) => x.id === msg.id);
      if (m?.replyHopId) { repliedAt = Date.now() - startedAt; replyHopId = m.replyHopId; }
    }
    await sleep(100);
  }
  const up = await status();
  say("4. running after start (ms)", runningAt);
  say("4. replied after start (ms) / replyHopId", `${repliedAt} / ${replyHopId}`);
  say("4. GET /v1/team-status", up);
  out.runningAfterMs = runningAt; out.repliedAfterMs = repliedAt; out.replyHopId = replyHopId; out.upStatus = up;

  // 5: Ctrl+C → running false on the next read
  const stopAt = Date.now();
  runner.kill("SIGTERM");
  let downAt: number | null = null;
  while (Date.now() - stopAt < 10_000) { if (!(await status()).running) { downAt = Date.now() - stopAt; break; } await sleep(50); }
  const exited = await Promise.race([runner.exited, sleep(5000).then(() => "still running")]);
  const down = await status();
  say("5. SIGTERM → running false after (ms)", downAt);
  say("5. runner exit", exited);
  say("5. GET /v1/team-status", down);
  out.downAfterMs = downAt; out.downStatus = down; out.runnerExit = exited;
  runner = null;
} finally {
  runner?.kill();
  await runner?.exited;
  server.stop(true);
  fake.stop();
  for (const d of made) rmSync(d, { recursive: true, force: true });
  console.log("\nSUMMARY " + JSON.stringify(out));
}
