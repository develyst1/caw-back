// Hops and runs (SPEC-A-008 § API, v1.1). A hop = one turn of one worker on one card, written by the runner (Team C)
// through this API: `hop.started` → (`hop.claimed`) → `hop.finished`, which counts in the project's hopsUsed. A run = the
// dispatcher's stretch of work with its own hop budget. Any valid actor may write them (the runner is not a worker).
import { eq } from "drizzle-orm";
import { isWorkable } from "../cards/view";
import type { Actor, HopOutcome, StopReason } from "../core/events";
import { newId, now } from "../core/ids";
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
    return { type: "hop.finished", projectId, actor, at: now(), data: { hopId, outcome: patch.outcome, tokensIn: patch.tokensIn ?? null, tokensOut: patch.tokensOut ?? null, note: patch.note ?? "" } };
  });
  return hopIn(state);
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
    return { type: "run.finished", projectId, actor, at: now(), data: { runId, stopReason: input.stopReason, report: input.report } };
  });
  return runView(state, state.runs.find((r) => r.id === runId)!);
}

/** Newest first. */
export async function listRuns(db: Db, projectId: string, limit: number): Promise<Run[]> {
  const s = await loadState(db, projectId);
  projectOf(s);
  return s.runs.sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit).map((r) => runView(s, r));
}
