// Dev script for TASK-C-031's Definition of Done (NOT part of the runner). Real runner process, real HTTP API on PORT (default 4530,
// PGlite in memory, Team A's fake Blueprint), and a FAKE `claude` (fake-claude.ts) — 0 real Claude usage.
//   bun run src/runner/e2e/auto.ts ac2   5 workable cards, budget 3          → exactly 3 hops, run budget_spent
//   bun run src/runner/e2e/auto.ts ac3   mode → manual mid-hop, and back      → hop finishes, no new hop, run operator_stopped, resumes
//   bun run src/runner/e2e/auto.ts ac4   runner stopped mid-hop, restarted    → interrupted + new hop, each card exactly once
//   bun run src/runner/e2e/auto.ts ac5   a worker asks the operator           → its card and its dependent wait, an independent card goes next
//   bun run src/runner/e2e/auto.ts r6a   a card sent back from review twice   → run failed_review_twice
//   bun run src/runner/e2e/auto.ts r6b   the (invented) limit event            → hop stopped with the Thai reset time, run limit_reached
//   bun run src/runner/e2e/auto.ts ac7   commented + asked + stopped           → the stored report, to check line by line
//   CHAT_TEXT='…' bun run src/runner/e2e/auto.ts chat   the entry worker answers ONE operator message (TASK-C-034): fake `claude` by default
//   THREAD_ANSWER='…' bun run src/runner/e2e/auto.ts thread   TASK-C-036: message 1 is answered by the FAKE (a question pack), message 2 (the operator's
//                                                        answer) by the REAL claude (haiku/low) — E2E_REAL is implied; RUNNER_TRACE_DIR keeps the streams
//                                                        (directives FAKE:propose · FAKE:amend · FAKE:questions in the text); E2E_REAL=1 → the REAL claude (haiku/low)
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app";
import { createBlueprint } from "../../blueprint/client";
import { createDb } from "../../db/client";
import { createFollower } from "../../follow/pull";
import { BP_PROJECT, fakeBlueprint } from "../../../test/helpers/fake-blueprint";

const scenario = process.argv[2] ?? "";
const PORT = Number(process.env.E2E_PORT || 4530); // not PORT: Bun loads caw-back/.env, which sets PORT for Team A's own server
const API = `http://127.0.0.1:${PORT}`;
const BACK = new URL("../../../", import.meta.url).pathname;
const WORKSPACE = process.env.CAW_WORKSPACE_ROOT || "";
if (!["ac2", "ac3", "ac4", "ac5", "r6a", "r6b", "ac7", "chat", "thread"].includes(scenario)) { console.error("usage: auto.ts ac2|ac3|ac4|ac5|r6a|r6b|ac7|chat|thread"); process.exit(1); }
if (!WORKSPACE) { console.error("CAW_WORKSPACE_ROOT is not set"); process.exit(1); }

const made: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
const say = (label: string, v: unknown) => console.log(`\n=== ${label}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);
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

// ---- seed: a project, one worker in its chain, a root folder, and the scenario's cards ----
const root = tmp("caw-c031-root-");
const project = await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT, version: 1 });
const worker = await call("POST", "/v1/workers", { name: "Blew", role: "BE", skills: ["role-be"], model: "haiku", effort: "low" });
await call("POST", `/v1/projects/${project.id}/chain/members`, { workerId: worker.id });
await call("PATCH", `/v1/projects/${project.id}/workspace`, { roots: [root] });
const card = (title: string, todo = "FAKE:", over: object = {}) =>
  call("POST", `/v1/projects/${project.id}/cards`, { title, todo, anchor: { key: "STEP-004", version: 1 }, assigneeId: worker.id, ...over });

const bin = join(tmp("caw-c031-bin-"), "fake-claude.sh");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" run "${new URL("./fake-claude.ts", import.meta.url).pathname}" "$@"\n`);
chmodSync(bin, 0o755);
// thread: the fake answers until `flag` exists, the real claude after (so message 1 costs nothing and message 2 is the one measured)
const flag = join(tmp("caw-c036-flag-"), "real");
const mixedBin = join(tmp("caw-c036-bin-"), "mixed-claude.sh");
writeFileSync(mixedBin, `#!/bin/sh\nif [ -e "${flag}" ]; then exec "${process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`}" "$@"; fi\nexec "${bin}" "$@"\n`);
chmodSync(mixedBin, 0o755);
const startRunner = () => Bun.spawn([process.execPath, "run", "src/runner/main.ts"], {
  cwd: BACK, stdout: "inherit", stderr: "inherit",
  env: { ...process.env, CAW_API_URL: API, CAW_WORKSPACE_ROOT: WORKSPACE, RUNNER_POLL_MS: "300", ...(scenario === "thread" ? { CLAUDE_BIN: mixedBin } : process.env.E2E_REAL ? {} : { CLAUDE_BIN: bin }) },
});

const hops = async () => ((await call("GET", `/v1/projects/${project.id}/hops?limit=200`)).hops as any[]).reverse(); // oldest first
const runs = async () => (await call("GET", `/v1/projects/${project.id}/runs`)).runs as any[];
const cards = async () => (await call("GET", `/v1/projects/${project.id}/cards`)).cards as any[];
const setMode = (mode: string, hopBudget?: number) => call("PATCH", `/v1/projects/${project.id}/mode`, { mode, ...(hopBudget === undefined ? {} : { hopBudget }) });
async function waitFor(what: string, ok: () => Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await ok())) { if (Date.now() > end) throw new Error(`timeout waiting for: ${what}`); await sleep(200); }
}
let numberOf: Record<string, number> = {};
const hopView = (h: any) => ({ card: h.cardId ? `#${numberOf[h.cardId]}` : "(chat message)", outcome: h.outcome, claimedBy: h.claimedBy?.slice(0, 8) ?? null, run: h.runId?.slice(-6) ?? null, endedAt: h.endedAt ? "yes" : "running" });
const cardView = async () => Promise.all((await cards()).map(async (c) => ({
  card: `#${c.number}`, title: c.title, status: c.status, workable: c.workable,
  notes: ((await call("GET", `/v1/cards/${c.id}/context`)).notes as any[]).map((n) => n.text),
})));
const project0 = async () => (await call("GET", `/v1/projects/${project.id}`));

let runner: ReturnType<typeof startRunner> | null = null;
try {
  if (scenario === "ac2") {
    for (let i = 1; i <= 5; i++) { const c = await card(`card ${i}`); numberOf[c.id] = c.number; }
    runner = startRunner();
    await setMode("dispatcher", 3);
    await waitFor("the run to end", async () => (await runs()).some((r) => r.endedAt));
    await sleep(1500); // a few more ticks: nothing more may happen
    say("GET …/hops (oldest first) — exactly 3", (await hops()).map(hopView));
    say("GET …/runs", (await runs()).map((r) => ({ hopBudget: r.hopBudget, hopsUsed: r.hopsUsed, stopReason: r.stopReason, report: r.report })));
    say("cards", (await cardView()).map((c) => `${c.card} ${c.status} workable=${c.workable}`));
  }

  if (scenario === "ac3") {
    const c1 = await card("card 1", "FAKE:sleep=3000"); numberOf[c1.id] = c1.number;
    for (const i of [2, 3]) { const c = await card(`card ${i}`); numberOf[c.id] = c.number; }
    runner = startRunner();
    await setMode("dispatcher", 10);
    await waitFor("hop 1 to be running", async () => (await hops()).some((h) => h.claimedBy && !h.endedAt));
    say("BEFORE the switch (hop 1 running): project hopsUsed + cards", { hopsUsed: (await project0()).hopsUsed, cards: await cardView() });
    await setMode("manual");
    say("switched to manual — hop 1 is still running", (await hops()).map(hopView));
    await waitFor("hop 1 to finish", async () => (await hops())[0]?.endedAt);
    await sleep(1200); // 4 ticks at 300 ms: no hop 2 may start
    say("hop 1 finished; 4 ticks later still ONE hop", (await hops()).map(hopView));
    say("runs", (await runs()).map((r) => ({ stopReason: r.stopReason, report: r.report, hopsUsed: r.hopsUsed })));
    say("AFTER (manual): project hopsUsed + cards", { hopsUsed: (await project0()).hopsUsed, cards: await cardView() });
    await setMode("dispatcher");
    await waitFor("a second run to end", async () => (await runs()).filter((r) => r.endedAt).length >= 2);
    say("switched back: hops (hop 2 took card 2, the next workable card)", (await hops()).map(hopView));
    say("runs", (await runs()).map((r) => ({ stopReason: r.stopReason, hopsUsed: r.hopsUsed })));
  }

  if (scenario === "ac4") {
    const c1 = await card("card 1", "FAKE:sleep=3000"); numberOf[c1.id] = c1.number;
    for (const i of [2, 3, 4]) { const c = await card(`card ${i}`); numberOf[c.id] = c.number; }
    runner = startRunner();
    await setMode("dispatcher", 10);
    await waitFor("hop 1 to be running", async () => (await hops()).some((h) => h.claimedBy && !h.endedAt));
    say("hop 1 running under runner A", (await hops()).map(hopView));
    runner.kill(); // SIGTERM to its own handle: the runner stops its child and exits, the hop is left running in the store
    await runner.exited;
    say("runner A is gone — the store still says hop 1 is running", (await hops()).map(hopView));
    runner = startRunner();
    await waitFor("the run to end", async () => (await runs()).some((r) => r.endedAt));
    say("hop list after runner B took over (oldest first)", (await hops()).map(hopView));
    const perCard: Record<string, string[]> = {};
    for (const h of await hops()) (perCard[`#${numberOf[h.cardId]}`] ??= []).push(h.outcome);
    say("outcomes per card — each card exactly once to `commented` (card #1 also has the interrupted one)", perCard);
    say("runs (one run throughout)", (await runs()).map((r) => ({ id: r.id.slice(-6), stopReason: r.stopReason, hopsUsed: r.hopsUsed })));
  }

  if (scenario === "ac5") {
    const A = await card("A (asks)", "FAKE:ask"); numberOf[A.id] = A.number;
    const B = await card("B (depends on A)", "FAKE:", { dependsOn: [A.id] }); numberOf[B.id] = B.number;
    const C = await card("C (independent)", "FAKE:"); numberOf[C.id] = C.number;
    runner = startRunner();
    await setMode("dispatcher", 10);
    await waitFor("hop 1 to end", async () => (await hops())[0]?.endedAt);
    say("GET …/cards?workable=true right after A asked — A and B wait, only C is workable", ((await call("GET", `/v1/projects/${project.id}/cards?workable=true`)).cards as any[]).map((c) => c.title));
    await waitFor("the run to end", async () => (await runs()).some((r) => r.endedAt));
    say("hop order (A first, then C; B never)", (await hops()).map(hopView));
    say("runs", (await runs()).map((r) => ({ stopReason: r.stopReason, report: r.report })));
    say("cards", (await cardView()).map((c) => `${c.card} ${c.title}: ${c.status} workable=${c.workable}`));
  }
  if (scenario === "r6a") {
    for (const i of [1, 2, 3]) { const c = await card(`card ${i}`); numberOf[c.id] = c.number; }
    const first = (await cards())[0];
    runner = startRunner();
    await setMode("dispatcher", 10);
    await waitFor("hop 1 to end", async () => (await hops())[0]?.endedAt);
    say("hop 1 done; card #1 is now", (await cards())[0].status);
    // the reviewer (the operator) sends it back twice: review → todo, then (re-submitted) review → todo
    const setStatus = (status: string) => call("PATCH", `/v1/cards/${first.id}/status`, { status });
    await setStatus("todo"); await setStatus("review"); await setStatus("todo");
    await waitFor("the run to end", async () => (await runs()).some((r) => r.endedAt));
    await sleep(1200);
    say("hops (the run stopped before another card was taken)", (await hops()).map(hopView));
    say("runs", (await runs()).map((r) => ({ stopReason: r.stopReason, report: r.report })));
  }

  if (scenario === "r6b") {
    const c1 = await card("card 1", "FAKE:limit"); numberOf[c1.id] = c1.number;
    for (const i of [2, 3]) { const c = await card(`card ${i}`); numberOf[c.id] = c.number; }
    runner = startRunner();
    await setMode("dispatcher", 10);
    await waitFor("the run to end", async () => (await runs()).some((r) => r.endedAt));
    await sleep(1500); // more ticks: no hop, no new run
    say("hops — one, stopped, with the Thai reset time", (await hops()).map((h) => ({ ...hopView(h), note: h.note })));
    say("runs — one, limit_reached, with its report", (await runs()).map((r) => ({ stopReason: r.stopReason, report: r.report })));
    say("project mode (the runner does not change it)", (await project0()).mode);
  }

  if (scenario === "ac7") {
    const A = await card("A comes out done", "FAKE:done"); numberOf[A.id] = A.number;
    const B = await card("B asks the operator", "FAKE:ask"); numberOf[B.id] = B.number;
    const C = await card("C is blocked", "FAKE:block"); numberOf[C.id] = C.number;
    runner = startRunner();
    await setMode("dispatcher", 10);
    await waitFor("the run to end", async () => (await runs()).some((r) => r.endedAt));
    const run = (await runs())[0];
    say("GET …/runs → report", run.report);
    say("GET …/hops?runId= (oldest first)", ((await call("GET", `/v1/projects/${project.id}/hops?limit=200&runId=${run.id}`)).hops as any[]).reverse().map((h) => ({ card: `#${numberOf[h.cardId]}`, outcome: h.outcome, tokensIn: h.tokensIn, tokensOut: h.tokensOut, note: h.note })));
    say("GET …/cards", (await cards()).map((c) => ({ card: `#${c.number}`, title: c.title, kind: c.kind, status: c.status, question: c.question?.text ?? null, answer: c.answer })));
    say("run row", { hopBudget: run.hopBudget, hopsUsed: run.hopsUsed, stopReason: run.stopReason, startedAt: run.startedAt, endedAt: run.endedAt });
  }
  if (scenario === "chat") {
    const text = process.env.CHAT_TEXT || "FAKE:questions ช่วยทำหน้าอนุมัติ";
    await call("PUT", `/v1/projects/${project.id}/chain/entry`, { workerId: worker.id });
    const P = `/v1/projects/${project.id}`;
    const msg = await call("POST", `${P}/chat`, { text });
    say("the operator wrote", { id: msg.id, text });
    runner = startRunner();
    await waitFor("the chat hop to end", async () => (await hops()).some((h) => h.messageId === msg.id && h.endedAt), 300_000);
    await sleep(800); // more ticks: no second hop
    say("hops (oldest first)", (await hops()).map((h) => ({ ...hopView(h), messageId: h.messageId === msg.id ? "the message" : h.messageId, workerId: h.workerId === worker.id ? "the entry worker" : h.workerId, runId: h.runId, tokensIn: h.tokensIn, tokensOut: h.tokensOut, note: h.note })));
    const chatNow = (await call("GET", `${P}/chat`)).messages as any[];
    say("GET …/chat", chatNow);
    const proposals = (await call("GET", `${P}/proposals`)).proposals as any[];
    say("GET …/proposals", proposals);
    const cardsBefore = await cards();
    say("GET …/cards BEFORE any accept", cardsBefore.map((c) => ({ number: c.number, title: c.title })));
    const open = proposals.find((p) => p.status === "open");
    if (open) {
      const accepted = await call("POST", `/v1/proposals/${open.id}/accept`);
      say("POST /v1/proposals/{id}/accept (as the operator)", accepted);
      say("GET …/cards AFTER accept", (await cards()).map((c) => ({ number: c.number, title: c.title, assigneeId: c.assigneeId === worker.id ? "the entry worker" : c.assigneeId, anchor: c.anchor, dependsOn: c.dependsOn.length })));
    }
    say("what caw-back sent to Blueprint (locate requests and amendments)", fake.mode.bodies.map((b: any) => ({ path: b.path.replace(/^\/v1\/projects\/[^/]+/, ""), body: b.body })));
  }
  if (scenario === "thread") {
    const P = `/v1/projects/${project.id}`;
    await call("PUT", `${P}/chain/entry`, { workerId: worker.id });
    const m1 = await call("POST", `${P}/chat`, { text: "แก้ขั้นอนุมัติห้องใหญ่ให้ผู้จัดการอนุมัติก่อน FAKE:questions" });
    runner = startRunner();
    await waitFor("the chat hop on message 1 to end", async () => (await hops()).some((h) => h.messageId === m1.id && h.endedAt), 120_000);
    writeFileSync(flag, "");
    const answer = process.env.THREAD_ANSWER || "1. ตามนั้น 2. ใช่ 3. ผู้จัดการแผนก";
    const m2 = await call("POST", `${P}/chat`, { text: answer });
    say("the operator answered (message 2)", { id: m2.id, text: answer });
    await waitFor("the chat hop on message 2 to end", async () => (await hops()).some((h) => h.messageId === m2.id && h.endedAt), 300_000);
    await sleep(800);
    say("hops (oldest first)", (await hops()).map((h) => ({ ...hopView(h), hopId: h.id, message: h.messageId === m1.id ? "1" : "2", tokensIn: h.tokensIn, tokensOut: h.tokensOut, note: h.note })));
    say("GET …/chat", (await call("GET", `${P}/chat`)).messages);
  }
} finally {
  runner?.kill();
  await runner?.exited;
  server.stop(true);
  fake.stop();
  for (const d of made) rmSync(d, { recursive: true, force: true });
}
