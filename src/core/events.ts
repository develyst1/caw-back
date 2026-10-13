// The event vocabulary (SPEC-A-008 § Event types). Every write is one event; the tables are what the reducer
// (reduce.ts) makes of them. `data` holds exactly the write's validated input plus server-made ids — never spec text.
export const EVENT_TYPES = [
  "project.created", "worker.created", "worker.combined",
  "chain.member_added", "chain.member_removed", "chain.edge_added", "chain.edge_removed", "chain.entry_set",
  "card.created", "card.dependency_added", "card.status_set", "card.assigned", "card.handed_off", "card.commented",
  "card.question_opened", "card.question_answered", "card.spec_changed", "card.spec_change_cleared",
  "project.mode_set", "project.budget_set", "project.workspace_set",
  "run.started", "run.finished",
  "hop.claimed", "hop.started", "hop.finished",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** `operator` or `worker:<workerId>` (SPEC § Identity). */
export type Actor = "operator" | `worker:${string}`;

type Header = { projectId: string | null; actor: string; at: string /* ISO-8601, server-made */ };
type WorkerData = { id: string; name: string; role: string; skills: string[]; model: string; effort: string };
export type CardStatus = "todo" | "doing" | "review" | "done" | "stuck";
export type Mode = "manual" | "dispatcher";
export type HopOutcome = "commented" | "handed_off" | "status" | "asked" | "failed" | "stopped" | "interrupted";
export type StopReason = "budget_spent" | "nothing_workable" | "failed_review_twice" | "limit_reached" | "operator_stopped" | "error";

// A member of this union arrives with the TASK that writes it (A-071: the project · A-072: workers, chain, cards ·
// A-073: mode, workspace, spec changes, runs, hops) — a reducer branch with no writer and no test would be unverified code.
// Every type in EVENT_TYPES is already reserved. Two stay unused: `card.dependency_added` (no route adds a dependency to an
// existing card — they are given when a card is created: card.created / card.question_opened) and `project.budget_set`
// (PATCH …/mode sets the mode and, optionally, the budget in ONE event: project.mode_set).
export type CawEvent = Header & (
  | { type: "project.created"; data: { id: string; name: string; blueprintProjectId: string; version: number } }
  | { type: "worker.created"; data: WorkerData }
  | { type: "worker.combined"; data: WorkerData & { combinedFrom: [string, string] } }
  | { type: "chain.member_added"; data: { workerId: string } }
  | { type: "chain.member_removed"; data: { workerId: string; reassignTo: string | null } }
  | { type: "chain.edge_added" | "chain.edge_removed"; data: { from: string; to: string } }
  | { type: "chain.entry_set"; data: { workerId: string } }
  | { type: "card.created"; data: { id: string; number: number; title: string; todo: string; anchor: { key: string; version: number }; assigneeId: string | null; dependsOn: string[] } }
  | { type: "card.status_set"; data: { cardId: string; status: CardStatus } }
  | { type: "card.assigned"; data: { cardId: string; workerId: string } }
  | { type: "card.handed_off"; data: { cardId: string; fromWorkerId: string | null; toWorkerId: string; noteId: string; text: string } }
  | { type: "card.commented"; data: { cardId: string; noteId: string; text: string } }
  | { type: "card.question_opened"; data: { askingCardId: string; id: string; number: number; text: string; proposedDefault: string; cases: string[] } }
  | { type: "card.question_answered"; data: { cardId: string; answer: string } }
  | { type: "card.spec_change_cleared"; data: { cardId: string } }
  // ONE event per Blueprint version the pull has seen: the cards it flags (possibly none) and the new latestSeenVersion
  | { type: "card.spec_changed"; data: { version: number; cardIds: string[] } }
  | { type: "project.mode_set"; data: { mode: Mode; hopBudget: number | null } }
  | { type: "project.workspace_set"; data: { roots: string[] } }
  | { type: "run.started"; data: { id: string; mode: Mode; hopBudget: number } }
  | { type: "run.finished"; data: { runId: string; stopReason: StopReason; report: string } }
  | { type: "hop.started"; data: { id: string; cardId: string; workerId: string; runId: string | null; claim: string | null } }
  | { type: "hop.claimed"; data: { hopId: string; claim: string } }
  | { type: "hop.finished"; data: { hopId: string; outcome: HopOutcome; tokensIn: number | null; tokensOut: number | null; note: string } }
);

export type StoredEvent = CawEvent & { seq: number };
