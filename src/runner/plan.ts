// What one automatic tick should do — a pure function of what the API said (SPEC-C-003 § 1, § 4; REQ-012 R3/R6; D-047).
// main.ts reads the store, calls this, and carries the answer out; nothing here touches the network or the clock.
import type { HopOutcome } from "./api";

export type StopReason = "budget_spent" | "nothing_workable" | "operator_stopped" | "failed_review_twice" | "no_progress";

/** hops that only commented (status unchanged) a card may have per worker per run before it counts as no progress (SPEC-116 D1) */
const COMMENT_TURNS = 2;

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
  /** a hop of this project is running (this runner's or an orphan's) */
  hopRunning: boolean;
  /** workers and cards with a running hop in this project (the store's and this process's) — one hop per worker and per card (REQ-122, SPEC-120 D5) */
  busyWorkers: string[];
  busyCards: string[];
  /** `GET …/cards?workable=true` */
  workable: { id: string; number: number; assigneeId: string | null }[];
  /** every hop of the open run, any state */
  hopsInRun: { cardId: string | null; workerId: string; outcome: HopOutcome | null }[];
};

export type Action =
  | { kind: "idle" }
  | { kind: "open_run" }
  | { kind: "finish_run"; runId: string; reason: StopReason; cardId?: string }
  | { kind: "start_hops"; hops: { cardId: string; workerId: string }[] }
  | { kind: "start_chat_hop"; messageId: string; workerId: string };

export function planTick(i: PlanInput): Action {
  // A chat message is the operator\'s go for one chat hop, in EITHER mode (D-053 Q-A): not gated by the mode, the run or its budget. It waits only for a
  // running hop of the ENTRY worker (REQ-122: the team works in parallel) and goes before any card — the operator is waiting for the answer (TASK-C-034).
  const chat: Action | null = i.pendingMessage && i.entryWorkerId && !i.busyWorkers.includes(i.entryWorkerId) ? { kind: "start_chat_hop", messageId: i.pendingMessage.id, workerId: i.entryWorkerId } : null;
  if (i.mode === "manual") {
    // the hop in progress finishes normally (AC-3); only the run ends, here
    return i.openRun ? { kind: "finish_run", runId: i.openRun.id, reason: "operator_stopped" } : (chat ?? { kind: "idle" });
  }
  if (i.openRun && i.reviewFailed !== null) return { kind: "finish_run", runId: i.openRun.id, reason: "failed_review_twice" };
  if (chat) return chat;
  if (!i.openRun) return i.runCanReopen ? { kind: "open_run" } : { kind: "idle" };
  // REQ-012 R6: the run ends. A hop in progress finishes on its own (as with operator_stopped) — only the run is closed.
  if (i.reviewFailed !== null) return { kind: "finish_run", runId: i.openRun.id, reason: "failed_review_twice" };
  // the API counts every hop of the run against its budget, running ones too, so the runner does not ask for one it knows will be refused;
  // a run whose budget is used up ends only when its running hops have finished
  const room = i.openRun.hopBudget - i.hopsInRun.length;
  if (room <= 0) return i.hopRunning ? { kind: "idle" } : { kind: "finish_run", runId: i.openRun.id, reason: "budget_spent" };

  // A card gets its turns per worker per run (SPEC-116 D1): a card whose hop failed or was stopped stays where it is and the run goes on with
  // the next card (SPEC-C-003 § 3); one that was only commented on (status unchanged) gets a second turn, then is not hopped in a loop.
  // An interrupted hop does not count — that card is still owed its turn. A card with no turn yet goes first, then a card's second turn.
  const commented = new Map<string, number>();
  const spent = new Set<string>();
  for (const h of i.hopsInRun) {
    if (h.outcome === null || h.outcome === "interrupted") continue;
    const pair = `${h.cardId}|${h.workerId}`;
    if (h.outcome === "commented") commented.set(pair, (commented.get(pair) ?? 0) + 1);
    else spent.add(pair);
  }
  const turned = [...i.workable].sort((a, b) => a.number - b.number).filter((c) => c.assigneeId !== null);
  const pairOf = (c: { id: string; assigneeId: string | null }) => `${c.id}|${c.assigneeId}`;
  const fresh = turned.filter((c) => !spent.has(pairOf(c)) && !commented.has(pairOf(c)));
  const second = turned.filter((c) => !spent.has(pairOf(c)) && (commented.get(pairOf(c)) ?? 0) < COMMENT_TURNS);
  // every idle worker gets its next card at once (REQ-122): fresh cards first, then second turns; never a busy worker or card, one card per worker, within the budget
  const busy = new Set(i.busyWorkers);
  const starts: { cardId: string; workerId: string }[] = [];
  for (const c of [...fresh, ...second]) {
    if (starts.length >= room) break;
    if (busy.has(c.assigneeId!) || i.busyCards.includes(c.id)) continue;
    busy.add(c.assigneeId!);
    starts.push({ cardId: c.id, workerId: c.assigneeId! });
  }
  if (starts.length > 0) return { kind: "start_hops", hops: starts };
  if (i.hopRunning) return { kind: "idle" }; // nothing to start while others work: wait for them, do not end the run
  // a workable card with an assignee is still there, but every turn on it is used up: say so, naming the card (SPEC-116 D2)
  return turned.length > 0
    ? { kind: "finish_run", runId: i.openRun.id, reason: "no_progress", cardId: turned[0].id }
    : { kind: "finish_run", runId: i.openRun.id, reason: "nothing_workable" };
}
