// The event vocabulary (SPEC-A-008 § Event types). Every write is one event; the tables are what the reducer
// (reduce.ts) makes of them. `data` holds exactly the write's validated input plus server-made ids — never spec text.
export const EVENT_TYPES = [
  "project.created", "worker.created", "worker.combined",
  "chain.member_added", "chain.member_removed", "chain.edge_added", "chain.edge_removed", "chain.entry_set",
  "card.created", "card.dependency_added", "card.status_set", "card.assigned", "card.handed_off", "card.commented",
  "card.question_opened", "card.question_answered", "card.spec_changed", "card.spec_change_cleared", "card.handoff_refused",
  "project.mode_set", "project.budget_set", "project.workspace_set",
  "run.started", "run.finished",
  "hop.claimed", "hop.started", "hop.finished",
  // v1.4 (REQ-013): chat, the locate keys kept on a chat hop, proposals. `proposal.superseded` stays reserved: a new proposal supersedes
  // the older open ones of its message INSIDE `proposal.made` ("in the same event").
  "chat.posted", "chat.replied", "hop.located", "proposal.made", "proposal.accepted", "proposal.superseded",
  // v1.9 (D-057): the operator asks for a failed chat step to be tried again
  "chat.retry_requested",
  // v1.10 (D-060): the operator edits a worker (name · roles · skills · model · effort)
  "worker.updated",
  // v1.11 (D-066): a running hop is still alive — the core stamps the time, throttled to one per 60 s
  "hop.heartbeat",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** `operator`, `worker:<workerId>`, or — contract v1.2, four routes only — `runner:<name>` (SPEC § Identity, § v1.2). */
export type Actor = "operator" | `worker:${string}` | `runner:${string}`;

type Header = { projectId: string | null; actor: string; at: string /* ISO-8601, server-made */ };
type WorkerData = { id: string; name: string; roles: string[]; skills: string[]; model: string; effort: string };
/** what `worker.created` / `worker.combined` carried before v1.10: one `role`. The reducer reads it as `roles: [role]`; the events are never rewritten. */
type LegacyWorkerData = Omit<WorkerData, "roles"> & { role: string };
export type WorkerPatch = Partial<Pick<WorkerData, "name" | "roles" | "skills" | "model" | "effort">>;
export type CardStatus = "todo" | "doing" | "review" | "done" | "stuck";
export type Mode = "manual" | "dispatcher";
export type HopOutcome = "commented" | "handed_off" | "status" | "asked" | "failed" | "stopped" | "interrupted" | "replied" | "proposed" | "amended" | "proposed_and_amended";
export type ChatQuestion = { text: string; proposedDefault: string; cases: string[] };
/** One card a proposal would create: CAW's own words + an anchor { key, version } — no spec text. `dependsOn` = indexes into the proposal's items. */
export type ProposalItem = { title: string; todo: string; anchor: { key: string; version: number }; workerId: string; dependsOn: number[]; hops: number };
export type StopReason = "budget_spent" | "nothing_workable" | "failed_review_twice" | "limit_reached" | "operator_stopped" | "error";

// A member of this union arrives with the TASK that writes it (A-071: the project · A-072: workers, chain, cards ·
// A-073: mode, workspace, spec changes, runs, hops) — a reducer branch with no writer and no test would be unverified code.
// Every type in EVENT_TYPES is already reserved. Two stay unused: `card.dependency_added` (no route adds a dependency to an
// existing card — they are given when a card is created: card.created / card.question_opened) and `project.budget_set`
// (PATCH …/mode sets the mode and, optionally, the budget in ONE event: project.mode_set).
export type CawEvent = Header & (
  | { type: "project.created"; data: { id: string; name: string; blueprintProjectId: string; version: number } }
  | { type: "worker.created"; data: WorkerData | LegacyWorkerData }
  | { type: "worker.combined"; data: (WorkerData | LegacyWorkerData) & { combinedFrom: [string, string] } }
  | { type: "worker.updated"; data: { id: string } & WorkerPatch }
  | { type: "chain.member_added"; data: { workerId: string } }
  | { type: "chain.member_removed"; data: { workerId: string; reassignTo: string | null } }
  | { type: "chain.edge_added" | "chain.edge_removed"; data: { from: string; to: string } }
  | { type: "chain.entry_set"; data: { workerId: string } }
  | { type: "card.created"; data: { id: string; number: number; title: string; todo: string; anchor: { key: string; version: number }; assigneeId: string | null; dependsOn: string[] } }
  | { type: "card.status_set"; data: { cardId: string; status: CardStatus } }
  | { type: "card.assigned"; data: { cardId: string; workerId: string } }
  | { type: "card.handed_off"; data: { cardId: string; fromWorkerId: string | null; toWorkerId: string; noteId: string; text: string } }
  | { type: "card.commented"; data: { cardId: string; noteId: string; text: string } }
  // v1.3 (D-051): a hand-off refused 409 chain_broken — recorded, the card itself untouched
  | { type: "card.handoff_refused"; data: { cardId: string; noteId: string; from: string | null; to: string; allowed: string[]; text: string } }
  | { type: "card.question_opened"; data: { askingCardId: string; id: string; number: number; text: string; proposedDefault: string; cases: string[] } }
  | { type: "card.question_answered"; data: { cardId: string; answer: string } }
  | { type: "card.spec_change_cleared"; data: { cardId: string } }
  // ONE event per Blueprint version the pull has seen: the cards it flags (possibly none) and the new latestSeenVersion
  | { type: "card.spec_changed"; data: { version: number; cardIds: string[] } }
  | { type: "project.mode_set"; data: { mode: Mode; hopBudget: number | null } }
  | { type: "project.workspace_set"; data: { roots: string[] } }
  | { type: "run.started"; data: { id: string; mode: Mode; hopBudget: number } }
  | { type: "run.finished"; data: { runId: string; stopReason: StopReason; report: string } }
  | { type: "hop.started"; data: { id: string; cardId: string | null; messageId: string | null; workerId: string; runId: string | null; claim: string | null } }
  | { type: "hop.heartbeat"; data: { hopId: string } }
  | { type: "hop.located"; data: { hopId: string; keys: string[] } }
  | { type: "chat.posted"; data: { id: string; text: string } }
  | { type: "chat.replied"; data: { id: string; messageId: string; hopId: string; text: string; questions: ChatQuestion[] | null; proposalId: string | null; amendment: { blueprintMessageId: string; link: string } | null } }
  | { type: "chat.retry_requested"; data: { messageId: string } }
  | { type: "proposal.made"; data: { id: string; messageId: string; version: number; items: ProposalItem[]; supersedes: string[] } }
  | { type: "proposal.accepted"; data: { proposalId: string; cardIds: string[] } }
  | { type: "hop.claimed"; data: { hopId: string; claim: string } }
  | { type: "hop.finished"; data: { hopId: string; outcome: HopOutcome; tokensIn: number | null; tokensOut: number | null; note: string } }
);

export type StoredEvent = CawEvent & { seq: number };
