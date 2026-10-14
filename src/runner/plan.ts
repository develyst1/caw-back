// What one automatic tick should do — a pure function of what the API said (SPEC-C-003 § 1, § 4; REQ-012 R3/R6; D-047).
// main.ts reads the store, calls this, and carries the answer out; nothing here touches the network or the clock.
import type { HopOutcome } from "./api";

export type StopReason = "budget_spent" | "nothing_workable" | "operator_stopped" | "failed_review_twice";

export type PlanInput = {
  mode: "manual" | "dispatcher";
  /** the project's open run (endedAt null), if any */
  openRun: { id: string; hopBudget: number } | null;
  /** only used with no open run: true when the project never had a run, or the operator switched the mode again AFTER the newest run ended.
   *  False means "that run is over and nobody asked for another": without it a run would open and end every tick. */
  runCanReopen: boolean;
  /** a card sent back from review twice during this run (watch.ts), or null */
  reviewFailed: string | null;
  /** the oldest operator chat message nobody has answered and the runner has not already tried, or null (main.ts finds it) */
  pendingMessage: { id: string } | null;
  /** the project\'s entry worker — the only one who answers the chat; null = none chosen yet */
  entryWorkerId: string | null;
  /** a hop of this project is running (this runner's or an orphan's) — one at a time per project (D-047 Q3) */
  hopRunning: boolean;
  /** `GET …/cards?workable=true` */
  workable: { id: string; number: number; assigneeId: string | null }[];
  /** every hop of the open run, any state */
  hopsInRun: { cardId: string | null; workerId: string; outcome: HopOutcome | null }[];
};

export type Action =
  | { kind: "idle" }
  | { kind: "open_run" }
  | { kind: "finish_run"; runId: string; reason: StopReason }
  | { kind: "start_hop"; cardId: string; workerId: string }
  | { kind: "start_chat_hop"; messageId: string; workerId: string };

export function planTick(i: PlanInput): Action {
  // A chat message is the operator\'s go for one chat hop, in EITHER mode (D-053 Q-A): not gated by the mode, the run or its budget. It waits for a
  // running hop (one at a time per project) and goes before any card — the operator is waiting for the answer (TASK-C-034).
  const chat: Action | null = i.pendingMessage && i.entryWorkerId && !i.hopRunning ? { kind: "start_chat_hop", messageId: i.pendingMessage.id, workerId: i.entryWorkerId } : null;
  if (i.mode === "manual") {
    // the hop in progress finishes normally (AC-3); only the run ends, here
    return i.openRun ? { kind: "finish_run", runId: i.openRun.id, reason: "operator_stopped" } : (chat ?? { kind: "idle" });
  }
  if (i.openRun && i.reviewFailed !== null) return { kind: "finish_run", runId: i.openRun.id, reason: "failed_review_twice" };
  if (chat) return chat;
  if (!i.openRun) return i.runCanReopen ? { kind: "open_run" } : { kind: "idle" };
  // REQ-012 R6: the run ends. A hop in progress finishes on its own (as with operator_stopped) — only the run is closed.
  if (i.reviewFailed !== null) return { kind: "finish_run", runId: i.openRun.id, reason: "failed_review_twice" };
  if (i.hopRunning) return { kind: "idle" };

  // the API counts every hop of the run against its budget, so the runner does not ask for one it knows will be refused
  if (i.hopsInRun.length >= i.openRun.hopBudget) return { kind: "finish_run", runId: i.openRun.id, reason: "budget_spent" };

  // A card gets one turn per worker per run: a card whose hop failed or was stopped stays where it is and the run goes on with the next
  // card (SPEC-C-003 § 3), and one that was only commented on (status unchanged) is not hopped in a loop until the budget is gone.
  // An interrupted hop does not count — that card is still owed its turn. Interpreted (reversible).
  const had = new Set(i.hopsInRun.filter((h) => h.outcome !== null && h.outcome !== "interrupted").map((h) => `${h.cardId}|${h.workerId}`));
  const next = [...i.workable]
    .sort((a, b) => a.number - b.number)
    .find((c) => c.assigneeId !== null && !had.has(`${c.id}|${c.assigneeId}`));
  return next ? { kind: "start_hop", cardId: next.id, workerId: next.assigneeId! } : { kind: "finish_run", runId: i.openRun.id, reason: "nothing_workable" };
}
