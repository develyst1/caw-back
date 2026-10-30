// The CAW runner: `bun run src/runner/main.ts`. One long-running local process next to the API, with no state of its own —
// everything it knows it reads from the API each tick, everything it does it writes through the API (SPEC-C-003 § 1).
// Manual mode (TASK-C-030): the operator's "ให้ทำต่อ" starts a hop through the API; the runner claims it and runs it.
// Automatic mode (TASK-C-031): with an open run the runner picks the next workable card itself, one hop at a time, until the budget is
// spent, nothing is workable, or the operator switches back to manual (plan.ts decides; this file carries it out).
// ONE runner per API: a hop claimed by another instance is taken for an orphan of a dead runner (a second live runner
// would interrupt the first one's hop).
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerApiError, createApi, type Hop, type HopOutcome, type Project, type StopReason } from "./api";
import { ConfigError, loadConfig } from "./config";
import { GuardError, probeHooks } from "./guard";
import { type Child, type HopDeps, NOTES, bunSpawn, eventsAfter, runHop } from "./hop";
import { planTick } from "./plan";
import { defaultHopsDir, listHopFiles, realProcs, reapLeftover, removeHopFile } from "./procs";
import { buildReport } from "./report";
import { ProjectWatch } from "./watch";
import { redact } from "./redact";
import { writeSettings } from "./settings";
import { secretValues } from "./screen";
import { TRACE_KEEP, rotateTraces, traceDirFrom } from "./trace";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** a hop that moved the card — it stops the count of turns without progress (SPEC-116 D4; a file written alone is not visible to the runner) */
const PROGRESS = new Set<HopOutcome>(["handed_off", "status"]);

/** REQ-012's words for why a run ended (decided 2026-10-14). */
const stopWords = (reason: StopReason, resetsAt: number | null, now: Date): string => ({
  budget_spent: "ใช้งบครบแล้ว",
  nothing_workable: "ไม่มีงานที่ทำต่อได้",
  failed_review_twice: "การ์ดนี้ไม่ผ่านตรวจสองครั้ง",
  limit_reached: NOTES.limit(resetsAt, now),
  operator_stopped: "คุณสั่งหยุด",
  error: "หยุดเพราะเกิดข้อผิดพลาด",
  no_progress: "มีงานที่ยังทำต่อได้ แต่ไม่คืบ",
})[reason];

export function createRunner(deps: HopDeps & { instance: string }) {
  const { api, instance } = deps;
  const log = (line: string) => deps.log(redact(line)); // nothing secret reaches the log (F8)
  const now = () => (deps.now ?? (() => new Date()))();
  const active = new Map<string, Promise<void>>(); // hop id → its run, while this process is running it
  const activeIn = new Map<string, string>(); // hop id → its project
  const noRunSeen = new Set<string>(); // projects that had no open run on the previous tick (see "grace" below)
  const refused = new Set<string>(); // `${run}|${card}|${worker}` the API refused to start a hop for — logged once, then skipped
  // What the runner has learned from each project's events (watch.ts). Derived data — rebuilt from seq 0 after a restart.
  const watches = new Map<string, ProjectWatch>();
  const chatCursor = new Map<string, string>(); // project → id of the last message of the leading run of messages that need nothing from us (rebuilt after a restart)
  const toldChat = new Set<string>(); // `${message}|${what}` already logged: say each thing about a message once, not every tick
  const refusedMessages = new Set<string>(); // `${message}|${entry worker}`: the API refused a chat hop for it — for THAT entry worker; another entry worker is a new chance
  const hopsDir = deps.hopsDir ?? defaultHopsDir();
  const procs = deps.procs ?? realProcs;

  /** The oldest operator message that needs a chat hop: not answered, not already tried (a hop of its own that ended other than interrupted), not
   *  refused. Scans only what is after the cursor, which moves over the leading messages that need nothing — so a long chat is not re-read every tick. */
  async function pendingMessage(project: Project, hops: Hop[]): Promise<{ id: string } | null> {
    let after = chatCursor.get(project.id);
    let settledEnd = after;
    let frozen = false;
    for (;;) {
      const page = await api.chatMessages(project.id, after);
      if (page.length === 0) break;
      for (const m of page) {
        // The hops listing is the newest 200. While it is complete (fewer than 200) "no hop for this message" is a fact; once it is full, a message
        // older than its oldest hop may well have been tried and failed — that cannot be known, so it is NOT hopped (an operator who still wants an
        // answer writes again). Said once.
        const unknowable = hops.length >= 200 && m.id < hops[hops.length - 1]!.id;
        if (unknowable && !toldChat.has(`${m.id}|old`)) { toldChat.add(`${m.id}|old`); log(`message ${m.id} is older than the hops the API lists (200) — whether it was tried is unknown, so it is left alone`); }
        // contract v1.9: a retry the operator asked for AFTER the message's last chat hop ended makes it pending again — never by itself
        const tried = hops.filter((h) => h.messageId === m.id && h.outcome !== null && h.outcome !== "interrupted");
        const retried = m.retryRequestedAt !== null && tried.every((h) => h.endedAt === null || Date.parse(h.endedAt) < Date.parse(m.retryRequestedAt!));
        const done = m.author !== "operator" || m.replyHopId !== null || unknowable || (tried.length > 0 && !retried);
        // an operator message that was tried and got no reply can still be retried later: the cursor stays BEFORE it
        if (done && m.author === "operator" && m.replyHopId === null && !unknowable) frozen = true;
        const refused = !done && refusedMessages.has(`${m.id}|${project.entryWorkerId}`);
        if (!done && !refused) { if (settledEnd !== undefined) chatCursor.set(project.id, settledEnd); return { id: m.id }; }
        // a refused message is skipped for now but the cursor stays BEFORE it: a fixed cause (another entry worker) must find it again
        if (refused) frozen = true;
        if (!frozen) settledEnd = m.id;
      }
      after = page[page.length - 1]!.id;
    }
    if (settledEnd !== undefined) chatCursor.set(project.id, settledEnd);
    return null;
  }

  /** Fold the project's new events in. */
  async function sync(projectId: string): Promise<ProjectWatch> {
    const w = watches.get(projectId) ?? new ProjectWatch();
    watches.set(projectId, w);
    for (;;) {
      const page = await api.events(projectId, w.cursor, 500);
      if (page.length === 0) return w;
      w.fold(page);
    }
  }

  /** Close a run with its report. The report is built ONLY from API reads (hops of the run, cards, the run's events), so it matches the store;
   *  if it cannot be built the run still ends, with the reason alone — a run must never be left open for want of a report. */
  async function endRun(projectId: string, runId: string, reason: StopReason, words: string = stopWords(reason, null, now())) {
    let report = words;
    try {
      const [runs, hops, cards, workers, watch] = await Promise.all([api.runs(projectId, 20), api.hopsOfRun(projectId, runId), api.cards(projectId), api.workers(), sync(projectId)]);
      const run = runs.find((r) => r.id === runId);
      if (!run) throw new Error(`run ${runId} not found`);
      const startSeq = watch.runStartSeq.get(runId);
      if (startSeq === undefined) log(`run ${runId}: its start was not seen in the events — the report will cover the project's whole history`);
      const events = await eventsAfter(api, projectId, Math.max(0, (startSeq ?? 1) - 1));
      report = buildReport({ run, now: now(), reasonWords: words, hops, cards, events, workerNames: Object.fromEntries(workers.map((w) => [w.id, w.name])) });
    } catch (e) {
      log(`run ${runId}: the report could not be built (${messageOf(e)}) — ending it with the reason alone`);
    }
    try { await api.finishRun(runId, { stopReason: reason, report }); } catch (e) {
      if (e instanceof RunnerApiError && e.code === "already_finished") return; // the screen got there first
      throw e;
    }
  }

  function launch(project: Project, hop: Hop) {
    const run = (async () => {
      const [workers, card] = await Promise.all([api.workers(), hop.cardId === null ? Promise.resolve(undefined) : api.card(hop.cardId)]); // a chat hop has no card
      const worker = workers.find((w) => w.id === hop.workerId);
      if (!worker) throw new Error(`worker ${hop.workerId} not found`);
      const result = await runHop(deps, { project, hop, worker, card });
      // The subscription limit (REQ-012 R6): the hop is already stopped; the run ends here. No new run opens by itself afterwards (watch.ts).
      if (result.limit && result.hop.runId) {
        try { await endRun(project.id, result.hop.runId, "limit_reached", stopWords("limit_reached", result.limit.resetsAt, now())); } catch (e) { log(`run ${result.hop.runId}: could not end it: ${messageOf(e)}`); }
      }
    })()
      .catch(async (e) => {
        // runHop finishes its own hop on every path; this is for a failure BEFORE it (worker or card lookup). Never leave the hop running.
        log(`hop ${hop.id}: ${messageOf(e)}`);
        await api.finishHop(hop.id, { outcome: "failed", note: redact(NOTES.fault(messageOf(e))).slice(0, 300) })
          .catch((e2) => log(`hop ${hop.id}: could not finish it: ${messageOf(e2)}`));
      })
      .finally(() => { active.delete(hop.id); activeIn.delete(hop.id); });
    active.set(hop.id, run);
    activeIn.set(hop.id, project.id);
  }

  /** Claim a running hop nobody has claimed, or end an orphan and run a new hop on its card. Returns whether a hop is running afterwards,
   *  and whether the listing it was given turned out to be stale (a hop had ended since) — then the caller must list again. */
  async function adopt(project: Project, hops: Hop[], openRunId: string | null): Promise<{ running: boolean; stale: boolean }> {
    let running = false;
    let stale = false;
    for (const hop of hops.filter((h) => h.endedAt === null)) {
      if (active.has(hop.id)) { running = true; continue; }
      if (hop.claimedBy === null) {
        let claimed: Hop;
        try { claimed = await api.claimHop(hop.id, instance); } catch (e) {
          if (e instanceof RunnerApiError && e.code === "already_claimed") { running = true; continue; } // another runner got there first
          throw e;
        }
        launch(project, claimed);
        running = true;
      } else {
        // claimed by another instance — or by this one but no longer being run: an orphan. End it, then run a new hop on the same card.
        // The listing is a snapshot: look again, so a hop that ended meanwhile (ours, just now) is not taken for an orphan.
        const now = (await api.hops(project.id, 200)).find((h) => h.id === hop.id);
        if (!now || now.endedAt !== null) { stale = true; continue; }
        if (active.has(hop.id)) { running = true; continue; }
        // The previous runner may have died without being able to stop its `claude` (kill -9, a crash). If that child is still working this
        // card, stop it BEFORE the hop is ended and another worker is put on the card — or the card is worked twice, in the same folder (DEF-1).
        const reaped = await reapLeftover(hop.id, { dir: hopsDir, procs, log, graceMs: deps.killGraceMs ?? 5000 });
        if (reaped === "stuck") { log(`hop ${hop.id}: its leftover process group will not stop — the hop is left running and no new worker is started on the card; trying again next tick`); running = true; continue; }
        if (reaped === "runner_alive") { running = true; continue; } // another runner is alive and this is ITS hop: leave it entirely
        if (reaped !== "none") removeHopFile(hopsDir, hop.id);
        await api.finishHop(hop.id, { outcome: "interrupted", note: NOTES.interrupted });
        try {
          // the same run, if it is still open; an ended run would refuse the hop (409 already_finished)
          const runId = hop.runId !== null && hop.runId === openRunId ? hop.runId : undefined;
          // a chat hop is restarted on its MESSAGE (and never in a run); a card hop on its card, in the same run if it is still open
          launch(project, await api.startHop(project.id, hop.messageId !== null
            ? { messageId: hop.messageId, workerId: hop.workerId, claim: instance }
            : { cardId: hop.cardId!, workerId: hop.workerId, claim: instance, ...(runId ? { runId } : {}) }));
          running = true;
        } catch (e) {
          // the old hop is already ended; say so by name rather than lose it. (Automatic mode picks the card again on the next tick;
          // in manual mode the operator starts it again.)
          log(`hop ${hop.id}: interrupted, but a new hop on ${hop.messageId !== null ? `message ${hop.messageId}` : `card ${hop.cardId}`} could not be started: ${messageOf(e)}`);
        }
      }
    }
    return { running, stale };
  }

  async function handle(project: Project, again = false): Promise<void> {
    const [listed, runs] = await Promise.all([api.hops(project.id, 200), api.runs(project.id, 20)]); // 200 = the most the API gives
    const openRun = runs.find((r) => r.endedAt === null) ?? null;
    const adopted = await adopt(project, listed, openRun?.id ?? null);
    // a hop this process is still finishing (its run may be about to end) counts as running too
    const hopRunning = adopted.running || [...activeIn.values()].includes(project.id);
    // a hop that ended since the listing must count toward its card's turn and the run's budget: list again
    const hops = adopted.stale ? await api.hops(project.id, 200) : listed;

    // A hop stopped for the subscription limit whose run could not be closed (the API failed just then): close it now, before anything else.
    // Read from the store, so it survives a restart. Its note is exactly the stop words.
    if (project.mode === "dispatcher" && openRun && !hopRunning) {
      const last = hops.filter((h) => h.runId === openRun.id).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
      if (last?.outcome === "stopped" && last.note.startsWith(NOTES.limit(null, now()))) return await endRun(project.id, openRun.id, "limit_reached", last.note);
    }

    // The mode is read here, every tick, never cached (AC-3).
    let workable: Awaited<ReturnType<typeof api.workableCards>> = [];
    if (project.mode === "dispatcher" && openRun && !hopRunning) {
      workable = (await api.workableCards(project.id)).filter((c) => !refused.has(`${openRun.id}|${c.id}|${c.assigneeId}`));
    }
    const pending = hopRunning ? null : await pendingMessage(project, hops);
    if (pending && !project.entryWorkerId && !toldChat.has(`${pending.id}|entry`)) {
      toldChat.add(`${pending.id}|entry`);
      log(`message ${pending.id} waits: the project has no entry worker to answer the chat`);
    }
    const action = planTick({
      mode: project.mode,
      openRun: openRun ? { id: openRun.id, hopBudget: openRun.hopBudget } : null,
      runCanReopen: project.mode === "dispatcher" && !openRun ? runs.length === 0 || (await sync(project.id)).switchedSince(runs[0]!.id) : false,
      reviewFailed: project.mode === "dispatcher" && openRun ? (await sync(project.id)).reviewFailedIn(openRun.id) : null,
      hopRunning,
      pendingMessage: pending,
      entryWorkerId: project.entryWorkerId,
      workable,
      hopsInRun: openRun ? hops.filter((h) => h.runId === openRun.id) : [],
    });

    if (action.kind !== "open_run") noRunSeen.delete(project.id);
    switch (action.kind) {
      case "idle": return;
      case "finish_run": {
        if (action.reason === "no_progress" && action.cardId) {
          // name the card and how many turns it had (SPEC-116 D2); a card that cannot be read must not keep the run open
          const card = await api.card(action.cardId).catch((e) => {
            log(`run ${action.runId}: the card ${action.cardId} could not be read for the no_progress words (${messageOf(e)}) — ending it with the generic words`);
            return null;
          });
          if (card) {
            // SPEC-116 D4: count the turns since the card's last progress — newest first, up to the first hop that moved it
            const ended = hops.filter((h) => h.runId === action.runId && h.cardId === card.id && h.outcome !== null && h.outcome !== "interrupted").sort((a, b) => (a.id < b.id ? 1 : -1));
            const turns = ended.findIndex((h) => PROGRESS.has(h.outcome!));
            const n = turns === -1 ? ended.length : turns;
            // 0 turns = the newest hop moved the card yet it is still workable: no number is true, so the generic words (D4 "Reachable 0")
            if (n > 0) return await endRun(project.id, action.runId, "no_progress", `#${card.number} ${card.title} ยังทำต่อได้ แต่ทำ ${n} รอบแล้วไม่คืบ — กด "อัตโนมัติ" เพื่อลองต่อ หรือเปิดการ์ดดู`);
          }
        }
        return await endRun(project.id, action.runId, action.reason);
      }
      case "open_run": {
        // Grace: the screen opens the run itself right after the mode switch (SPEC-C-003 § 6). One quiet tick lets it; then the fallback opens one.
        if (!noRunSeen.has(project.id)) { noRunSeen.add(project.id); return; }
        noRunSeen.delete(project.id);
        try { await api.startRun(project.id, project.hopBudget); } catch (e) {
          if (e instanceof RunnerApiError && e.code === "run_open") return; // the screen opened it just now
          throw e;
        }
        return again ? undefined : await handle(project, true);
      }
      case "start_chat_hop": {
        try {
          launch(project, await api.startHop(project.id, { messageId: action.messageId, workerId: action.workerId, claim: instance })); // no run: typing is not automatic work
        } catch (e) {
          if (!(e instanceof RunnerApiError)) throw e;
          if (e.code === "hop_running" || e.code === "already_answered") return; // lost a race; the next tick sees how it ended
          const key = `${action.messageId}|${e.code}|${action.workerId}`;
          if (!toldChat.has(key)) { toldChat.add(key); log(`message ${action.messageId}: the API refused a chat hop (${e.status} ${e.code}: ${e.message})`); }
          // a refusal for the BUDGET may be lifted (the operator raises it; C-Q9 will exempt chat), so the message is tried again; any other 4xx will not change
          if (e.code !== "no_budget" && e.status >= 400 && e.status < 500) refusedMessages.add(`${action.messageId}|${action.workerId}`);
          else if (e.code !== "no_budget") throw e;
        }
        return;
      }
      case "start_hop": {
        try {
          launch(project, await api.startHop(project.id, { cardId: action.cardId, workerId: action.workerId, runId: openRun!.id, claim: instance }));
        } catch (e) {
          if (!(e instanceof RunnerApiError)) throw e;
          if (e.code === "hop_running" || e.code === "not_workable") return; // lost a race; the next tick sees how it ended
          if (e.code === "no_budget") return await endRun(project.id, openRun!.id, "budget_spent"); // the run's budget, filled since the listing (REQ-120: the only budget)
          if (e.status >= 400 && e.status < 500) {
            // e.g. not_a_member (the card's assignee is not in the chain): that card's problem, not the run's. Say so once, leave the
            // card where it is, and go on with the next one
            refused.add(`${openRun!.id}|${action.cardId}|${action.workerId}`);
            log(`card ${action.cardId}: the API refused a hop for worker ${action.workerId} (${e.code}) — skipped for this run`);
            return;
          }
          throw e; // not the card's fault (network, 5xx, unreadable body): the tick logs it and the next tick tries again — the card is NOT banned
        }
        return;
      }
    }
  }

  return {
    /** At start: a hop file whose hop has finished in the store (or that the store does not know) is a leftover of a dead runner — stop what is
     *  left of it and delete the file. A hop still running in the store is left to the orphan rule (adopt). Files of another API are not touched. */
    async sweepStray() {
      for (const f of listHopFiles(hopsDir, log)) {
        if (f.apiUrl !== deps.config.apiUrl) continue;
        try {
          const hop = (await api.hops(f.projectId, 200)).find((h) => h.id === f.hopId);
          if (hop && hop.endedAt === null) continue;
          const reaped = await reapLeftover(f.hopId, { dir: hopsDir, procs, log, graceMs: deps.killGraceMs ?? 5000 });
          if (reaped !== "stuck" && reaped !== "runner_alive") removeHopFile(hopsDir, f.hopId);
        } catch (e) { log(`hop file ${f.hopId}: ${messageOf(e)}`); }
      }
    },
    async tick() {
      let projects: Project[];
      try { projects = await api.projects(); } catch (e) { log(`projects: ${messageOf(e)}`); return; }
      for (const p of projects) {
        try { await handle(p); } catch (e) { log(`project ${p.id}: ${messageOf(e)}`); }
      }
    },
    /** resolves when no hop is being run by this runner */
    async idle() { while (active.size > 0) await Promise.all([...active.values()]); },
    get running() { return active.size; },
  };
}

/** How often the runner says it is alive (contract v1.16 rev. 1: the core calls it running while the last check-in is <= 45 s old). */
export const CHECK_IN_MS = 15_000;

/** The runner's check-in (TASK-C-040): `running` at start and then on its OWN timer — not the poll loop, not a hop — and one `stopping` at a clean stop.
 *  A failed check-in is logged once per failure streak (and once on recovery) and never stops the runner. `every` is the scheduler (default setInterval). */
export function createCheckIn(o: {
  api: { checkIn(state: "running" | "stopping"): Promise<void> }; log: (line: string) => void;
  intervalMs?: number; stopTimeoutMs?: number; every?: (fn: () => void, ms: number) => () => void;
}) {
  const every = o.every ?? ((fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); });
  let cancel: (() => void) | null = null;
  let closed = false;
  let failing = false;
  let inFlight = false;
  const send = async (state: "running" | "stopping") => {
    try {
      await o.api.checkIn(state);
      if (failing) { failing = false; o.log("check-in is back"); }
    } catch (e) {
      if (!failing) { failing = true; o.log(`check-in failed: ${e instanceof RunnerApiError ? `${e.code} (${e.status})` : messageOf(e)} — the team shows as not running until it works; the runner goes on, and says so once more when it is back`); }
      else if (state === "stopping") o.log(`check-in (stopping) failed: ${messageOf(e)}`);
    }
  };
  return {
    /** the first check-in is awaited (it is sent before the first tick), then the timer runs */
    async start() {
      await send("running");
      cancel = every(() => { if (closed || inFlight) return; inFlight = true; void send("running").finally(() => { inFlight = false; }); }, o.intervalMs ?? CHECK_IN_MS);
    },
    /** clear the timer and send ONE `stopping`, waiting at most `stopTimeoutMs` (default 1 s) for it; a second call does nothing */
    async stop() {
      if (closed) return;
      closed = true;
      cancel?.();
      const ms = o.stopTimeoutMs ?? 1000;
      const answered = await Promise.race([send("stopping").then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
      if (!answered) o.log(`check-in (stopping) did not answer within ${ms} ms — stopping anyway`);
    },
  };
}

if (import.meta.main) {
  let config;
  try { config = loadConfig(); await probeHooks(config.hooks); } catch (e) {
    if (e instanceof ConfigError || e instanceof GuardError) { console.error(`runner: ${e.message}`); process.exit(1); }
    throw e;
  }
  const instance = crypto.randomUUID();
  const tmpRoot = join(tmpdir(), `caw-runner-${instance}`);
  const settingsFile = writeSettings(tmpRoot, config.hooks);
  const log = (line: string) => console.log(`${new Date().toISOString()} [runner ${instance.slice(0, 8)}] ${line}`);

  const traceDir = traceDirFrom(process.env);
  rotateTraces(traceDir, TRACE_KEEP, log);

  // REQ-104: the values the worker's screen must never show, built once from this process's environment (Bun has loaded the repo's .env into it)
  const secrets = secretValues(process.env);

  const live = new Set<Child>();
  let stopping = false;
  const api = createApi(config.apiUrl, `runner:${instance}`);
  const checkIn = createCheckIn({ api, log });
  const runner = createRunner({
    api, config, tmpRoot, settingsFile, log, cursors: new Map(), instance, stopping: () => stopping, traceDir, secrets,
    spawn: (cmd, opts) => { const c = bunSpawn(cmd, opts); live.add(c); void c.exited.finally(() => live.delete(c)); return c; },
  });

  // Stopping the runner stops its own children (proc.kill() on handles it owns). A child left running would keep writing to the
  // store while the next runner re-runs its hop as an orphan. The hop rows stay "running"; the next start marks them interrupted.
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping ${live.size} child process(es)`);
    for (const c of live) c.kill();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { log(`could not remove ${tmpRoot}: ${messageOf(e)}`); }
    // tell the core before going: the team shows as not running at once, not 45 s later. At most 1 s; a failure is only logged.
    void checkIn.stop().finally(() => setTimeout(() => process.exit(0), 200));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  log(`started — API ${config.apiUrl}, poll ${config.pollMs} ms, hop cap ${config.hopMaxMs} ms, workspace ${config.workspaceRoot}, traces ${traceDir}`);
  await checkIn.start(); // before the first tick; then every 15 s on its own timer
  await runner.sweepStray();
  while (!stopping) {
    await runner.tick();
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
}
