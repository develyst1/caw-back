// Hops and runs (SPEC-A-008 § API, v1.1). A hop = one turn of one worker on one card, written by the runner (Team C)
// through this API: `hop.started` → (`hop.claimed`) → `hop.finished`, which counts in the project's hopsUsed. A run = the
// dispatcher's stretch of work with its own hop budget. Any valid actor may write them (the runner is not a worker).
import { eq } from "drizzle-orm";
import { isWorkable } from "../cards/view";
import type { Actor, CawEvent, HopOutcome, StopReason } from "../core/events";
import { newId, now } from "../core/ids";
import { rewritePaths } from "../core/paths";
import type { HopState, RunState, State } from "../core/reduce";
import { isUuid, loadState } from "../core/state";
import { writeDecided } from "../core/write";
import type { Db } from "../db/client";
import { hops as hopsTable, runs as runsTable } from "../db/schema";
import { ApiError, notFound } from "../http/errors";

export type Hop = HopState;
export type Run = RunState & { hopsUsed: number };

const projectOf = (s: State) => s.project ?? (() => { throw notFound("project"); })();
const runView = (s: State, r: RunState): Run => ({ ...r, hopsUsed: s.hops.filter((h) => h.runId === r.id && h.messageId === null && h.endedAt !== null).length });

async function projectIdOf(db: Db, table: typeof hopsTable | typeof runsTable, id: string, what: string): Promise<string> {
  const [row] = isUuid(id) ? await db.select({ projectId: table.projectId }).from(table).where(eq(table.id, id)) : [];
  if (!row) throw notFound(what);
  return row.projectId;
}

// ---------- hops ----------
// A hop is on a CARD or — v1.4, REQ-013 — on a chat MESSAGE (exactly one of the two). A chat hop belongs to the project's entry worker
// and answers an operator message nobody has answered yet; it has no "workable" check.
export async function startHop(db: Db, actor: Actor, projectId: string,
  input: { cardId?: string; messageId?: string; workerId: string; runId?: string; claim?: string }): Promise<Hop> {
  const id = newId();
  if ((input.cardId === undefined) === (input.messageId === undefined)) throw new ApiError(400, "validation", "give exactly one of cardId and messageId");
  const { state } = await writeDecided(db, projectId, (s) => {
    const project = projectOf(s);
    const card = input.cardId === undefined ? null : s.cards.find((c) => c.id === input.cardId) ?? (() => { throw notFound("card"); })();
    const message = input.messageId === undefined ? null : s.chat.find((m) => m.id === input.messageId) ?? (() => { throw notFound("message"); })();
    if (!s.members.includes(input.workerId)) throw new ApiError(400, "not_a_member", `worker ${input.workerId} is not in this project's chain`);
    if (message) {
      if (project.entryWorkerId !== input.workerId) throw new ApiError(400, "not_entry_worker", "only the project's entry worker answers the chat");
      if (message.author !== "operator") throw new ApiError(400, "validation", "a chat hop answers an operator message");
      if (message.replyHopId !== null) throw new ApiError(409, "already_answered", "that message has already been answered");
    }
    const run = input.runId === undefined ? null : s.runs.find((r) => r.id === input.runId) ?? (() => { throw notFound("run"); })();
    if (run && run.endedAt !== null) throw new ApiError(409, "already_finished", "that run has ended");
    if (card && !isWorkable(s, card)) throw new ApiError(409, "not_workable", "that card is not workable (a question, done, in review, waiting on a card, or its spec changed)");
    if (s.hops.some((h) => h.endedAt === null)) throw new ApiError(409, "hop_running", "this project already has a hop running");
    // a chat hop is outside every budget (v1.8, D-055): it is neither checked against one nor counted in one
    if (!message && project.mode === "dispatcher" && project.hopsUsed >= project.hopBudget) {
      throw new ApiError(409, "no_budget", `the project's hop budget (${project.hopBudget}) is spent`);
    }
    if (!message && run && s.hops.filter((h) => h.runId === run.id && h.messageId === null).length >= run.hopBudget) {
      throw new ApiError(409, "no_budget", `the run's hop budget (${run.hopBudget}) is spent`);
    }
    return { type: "hop.started", projectId, actor, at: now(), data: { id, cardId: card?.id ?? null, messageId: message?.id ?? null, workerId: input.workerId, runId: run?.id ?? null, claim: input.claim ?? null } };
  });
  return state.hops.find((h) => h.id === id)!;
}

export type HopPatch = { claim: string } | { outcome: HopOutcome; tokensIn?: number; tokensOut?: number; note?: string };

/** D-103 DEF-2: the runner (and a worker) write notes and reports that quote file paths; the core takes machine paths out in this one place. The operator's own text never. */
const cleanText = (actor: Actor, text: string, s: State): string => (actor === "operator" ? text : rewritePaths(text, s.project?.workspace.roots ?? []));

export async function patchHop(db: Db, actor: Actor, hopId: string, patch: HopPatch): Promise<Hop> {
  const projectId = await projectIdOf(db, hopsTable, hopId, "hop");
  const hopIn = (s: State) => s.hops.find((h) => h.id === hopId) ?? (() => { throw notFound("hop"); })();
  if ("claim" in patch) {
    // the same claim again is a no-op (200); another is refused; a claim is for a hop that is still running
    const now0 = hopIn(await loadState(db, projectId));
    if (now0.endedAt === null && now0.claimedBy === patch.claim) return now0;
  }
  const { state } = await writeDecided(db, projectId, (s) => {
    const hop = hopIn(s);
    if (hop.endedAt !== null) throw new ApiError(409, "already_finished", "that hop has finished");
    if ("claim" in patch) {
      if (hop.claimedBy !== null) throw new ApiError(409, "already_claimed", "that hop is claimed by another runner");
      return { type: "hop.claimed", projectId, actor, at: now(), data: { hopId, claim: patch.claim } };
    }
    const at = now();
    const finished: CawEvent = { type: "hop.finished", projectId, actor, at, data: { hopId, outcome: patch.outcome, tokensIn: patch.tokensIn ?? null, tokensOut: patch.tokensOut ?? null, note: cleanText(actor, patch.note ?? "", s) } };
    // SPEC-108 D6 (REQ-111): a card is never left `doing` without a hop. A finished CARD hop whose card is still `doing` (the worker did not move it) sends it back to
    // `todo` in the same write, whatever the outcome — a plain event, so a rebuild replays it. A worker that moved it (review / done / stuck) is left alone; a chat hop has no card.
    const card = hop.cardId === null ? undefined : s.cards.find((c) => c.id === hop.cardId);
    return card?.status === "doing" ? [finished, { type: "card.status_set", projectId, actor, at, data: { cardId: card.id, status: "todo" } }] : finished;
  });
  return hopIn(state);
}

/** A heartbeat under this old writes nothing (SPEC § v1.11): a runner may call every 30 s, a 20-minute hop gets ~20 events. */
const HEARTBEAT_MIN_GAP_MS = 60_000;
class Fresh extends Error { constructor(readonly lastActivityAt: string) { super("fresh"); } } // thrown inside the decision: rolls the (empty) write back

/** The runner says a running hop is still alive. The core stamps the time; under 60 s since the last write → nothing is written, the current value comes back. */
export async function heartbeatHop(db: Db, actor: Actor, hopId: string): Promise<{ lastActivityAt: string }> {
  if (!actor.startsWith("runner:")) throw new ApiError(403, "runner_only", "only a runner sends a hop heartbeat");
  const projectId = await projectIdOf(db, hopsTable, hopId, "hop");
  try {
    const { state } = await writeDecided(db, projectId, (s) => {
      const hop = s.hops.find((h) => h.id === hopId) ?? (() => { throw notFound("hop"); })();
      if (hop.endedAt !== null) throw new ApiError(409, "hop_not_running", "that hop has finished");
      const at = now();
      if (Date.parse(at) - Date.parse(hop.lastActivityAt) < HEARTBEAT_MIN_GAP_MS) throw new Fresh(hop.lastActivityAt);
      return { type: "hop.heartbeat", projectId, actor, at, data: { hopId } };
    });
    return { lastActivityAt: state.hops.find((h) => h.id === hopId)!.lastActivityAt };
  } catch (e) {
    if (e instanceof Fresh) return { lastActivityAt: e.lastActivityAt };
    throw e;
  }
}

/** Newest first. */
export async function listHops(db: Db, projectId: string, q: { limit: number; runId?: string }): Promise<Hop[]> {
  const s = await loadState(db, projectId);
  projectOf(s);
  return s.hops.filter((h) => q.runId === undefined || h.runId === q.runId).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, q.limit);
}

// ---------- runs ----------
export async function startRun(db: Db, actor: Actor, projectId: string, hopBudget: number): Promise<Run> {
  const id = newId();
  const { state } = await writeDecided(db, projectId, (s) => {
    const project = projectOf(s);
    if (s.runs.some((r) => r.endedAt === null)) throw new ApiError(409, "run_open", "this project already has an open run");
    return { type: "run.started", projectId, actor, at: now(), data: { id, mode: project.mode, hopBudget } };
  });
  return runView(state, state.runs.find((r) => r.id === id)!);
}

export async function finishRun(db: Db, actor: Actor, runId: string, input: { stopReason: StopReason; report: string }): Promise<Run> {
  const projectId = await projectIdOf(db, runsTable, runId, "run");
  const { state } = await writeDecided(db, projectId, (s) => {
    const run = s.runs.find((r) => r.id === runId) ?? (() => { throw notFound("run"); })();
    if (run.endedAt !== null) throw new ApiError(409, "already_finished", "that run has already finished");
    return { type: "run.finished", projectId, actor, at: now(), data: { runId, stopReason: input.stopReason, report: cleanText(actor, input.report, s) } };
  });
  return runView(state, state.runs.find((r) => r.id === runId)!);
}

/** Newest first. */
export async function listRuns(db: Db, projectId: string, limit: number): Promise<Run[]> {
  const s = await loadState(db, projectId);
  projectOf(s);
  return s.runs.sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit).map((r) => runView(s, r));
}
