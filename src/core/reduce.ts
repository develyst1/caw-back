// The one reducer: (state, event) → state. Pure — no I/O, no clock, no ids of its own (they are in the event).
// The write path applies it to the tables; a rebuild runs it over the stored events from `empty`. Same function, so the
// tables and a rebuild cannot disagree except by someone writing the tables behind the events' back (AC-6).
import type { CardStatus, CawEvent, ChatQuestion, HopOutcome, Mode, ProposalItem, StopReason } from "./events";

export type ProjectState = {
  id: string; name: string; blueprintProjectId: string; version: number; latestSeenVersion: number;
  mode: Mode; hopBudget: number; hopsUsed: number; workspace: { roots: string[] };
  entryWorkerId: string | null; createdAt: string;
};
export type WorkerState = {
  id: string; name: string; role: string; skills: string[]; model: string; effort: string; combinedFrom: string[] | null; createdAt: string;
};
export type CardState = {
  id: string; projectId: string; number: number; kind: "work" | "question"; title: string; todo: string; status: CardStatus;
  assigneeId: string | null; anchorKey: string; anchorVersion: number; specChangedVersion: number | null;
  question: { text: string; proposedDefault: string; cases: string[] } | null; answer: string | null; createdAt: string; updatedAt: string;
};
export type NoteState = {
  id: string; cardId: string; type: "comment" | "handoff" | "handoff_refused"; actor: string; text: string;
  fromWorkerId: string | null; toWorkerId: string | null; allowed: string[] | null; at: string;
};
export type ChatMessageState = {
  id: string; projectId: string; author: string; text: string; replyTo: string | null; replyHopId: string | null;
  questions: ChatQuestion[] | null; proposalId: string | null; amendment: { blueprintMessageId: string; link: string } | null; at: string;
  retryRequestedAt: string | null; // v1.9: set by chat.retry_requested, cleared by the next hop.started on the message
};
export type ProposalState = {
  id: string; projectId: string; messageId: string; version: number; items: ProposalItem[]; status: "open" | "accepted" | "superseded";
  cardIds: string[] | null; createdAt: string;
};
export type HopState = {
  id: string; projectId: string; runId: string | null; claimedBy: string | null; cardId: string | null; messageId: string | null; locatedKeys: string[] | null; workerId: string;
  startedAt: string; endedAt: string | null; outcome: HopOutcome | null; tokensIn: number | null; tokensOut: number | null; note: string;
};
export type RunState = {
  id: string; projectId: string; mode: Mode; hopBudget: number; startedAt: string; endedAt: string | null; stopReason: StopReason | null; report: string | null;
};
// One project's slice plus every worker (workers are global).
export type State = {
  project: ProjectState | null;
  workers: WorkerState[];
  members: string[]; // worker ids in this project's chain
  edges: { from: string; to: string }[];
  cards: CardState[];
  deps: { cardId: string; dependsOnId: string }[];
  notes: NoteState[];
  hops: HopState[];
  runs: RunState[];
  chat: ChatMessageState[];
  proposals: ProposalState[];
};

export const empty: State = { project: null, workers: [], members: [], edges: [], cards: [], deps: [], notes: [], hops: [], runs: [], chat: [], proposals: [] };

/** Sorted arrays, so two States that mean the same thing compare equal as JSON. */
export function canonical(s: State): State {
  const by = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return {
    project: s.project,
    workers: by(s.workers, (w) => `${w.createdAt}|${w.id}`),
    members: [...s.members].sort(),
    edges: by(s.edges, (e) => `${e.from}|${e.to}`),
    cards: by(s.cards, (c) => String(c.number).padStart(9, "0")),
    deps: by(s.deps, (d) => `${d.cardId}|${d.dependsOnId}`),
    notes: by(s.notes, (n) => n.id), // ids are time-ordered (core/ids.ts): id order is creation order
    hops: by(s.hops, (h) => h.id),
    runs: by(s.runs, (r) => r.id),
    chat: by(s.chat, (m) => m.id),
    proposals: by(s.proposals, (p) => p.id),
  };
}

const touch = (cards: CardState[], id: string, at: string, change: Partial<CardState>): CardState[] =>
  cards.map((c) => (c.id === id ? { ...c, ...change, updatedAt: at } : c));

export function reduce(state: State, event: CawEvent): State {
  switch (event.type) {
    case "project.created": {
      if (state.project) throw new Error("project.created twice");
      const d = event.data;
      return { ...state, project: {
        id: d.id, name: d.name, blueprintProjectId: d.blueprintProjectId, version: d.version, latestSeenVersion: d.version,
        mode: "manual", hopBudget: 0, hopsUsed: 0, workspace: { roots: [] }, entryWorkerId: null, createdAt: event.at,
      } };
    }
    case "worker.created":
      return { ...state, workers: [...state.workers, { ...event.data, combinedFrom: null, createdAt: event.at }] };
    case "worker.combined":
      return { ...state, workers: [...state.workers, { ...event.data, combinedFrom: [...event.data.combinedFrom], createdAt: event.at }] };
    case "chain.member_added":
      return { ...state, members: [...state.members, event.data.workerId] };
    case "chain.member_removed": {
      const { workerId, reassignTo } = event.data;
      return {
        ...state,
        members: state.members.filter((m) => m !== workerId),
        edges: state.edges.filter((e) => e.from !== workerId && e.to !== workerId),
        // its open cards move in the same event (SPEC § Re-assign): the count is unchanged, done cards stay
        cards: reassignTo === null ? state.cards : state.cards.map((c) =>
          c.assigneeId === workerId && c.status !== "done" ? { ...c, assigneeId: reassignTo, updatedAt: event.at } : c),
      };
    }
    case "chain.edge_added":
      return { ...state, edges: [...state.edges, { from: event.data.from, to: event.data.to }] };
    case "chain.edge_removed":
      return { ...state, edges: state.edges.filter((e) => !(e.from === event.data.from && e.to === event.data.to)) };
    case "chain.entry_set":
      return { ...state, project: state.project && { ...state.project, entryWorkerId: event.data.workerId } };
    case "card.created": {
      const d = event.data;
      const card: CardState = {
        id: d.id, projectId: event.projectId!, number: d.number, kind: "work", title: d.title, todo: d.todo, status: "todo",
        assigneeId: d.assigneeId, anchorKey: d.anchor.key, anchorVersion: d.anchor.version, specChangedVersion: null,
        question: null, answer: null, createdAt: event.at, updatedAt: event.at,
      };
      return { ...state, cards: [...state.cards, card], deps: [...state.deps, ...d.dependsOn.map((dependsOnId) => ({ cardId: d.id, dependsOnId }))] };
    }
    case "card.status_set":
      return { ...state, cards: touch(state.cards, event.data.cardId, event.at, { status: event.data.status }) };
    case "card.assigned":
      return { ...state, cards: touch(state.cards, event.data.cardId, event.at, { assigneeId: event.data.workerId }) };
    case "card.handed_off": {
      const d = event.data;
      const note: NoteState = { id: d.noteId, cardId: d.cardId, type: "handoff", actor: event.actor, text: d.text, fromWorkerId: d.fromWorkerId, toWorkerId: d.toWorkerId, allowed: null, at: event.at };
      return { ...state, cards: touch(state.cards, d.cardId, event.at, { assigneeId: d.toWorkerId }), notes: [...state.notes, note] };
    }
    case "card.commented": {
      const d = event.data;
      const note: NoteState = { id: d.noteId, cardId: d.cardId, type: "comment", actor: event.actor, text: d.text, fromWorkerId: null, toWorkerId: null, allowed: null, at: event.at };
      return { ...state, notes: [...state.notes, note] };
    }
    case "card.handoff_refused": {
      const d = event.data;
      const note: NoteState = { id: d.noteId, cardId: d.cardId, type: "handoff_refused", actor: event.actor, text: d.text, fromWorkerId: d.from, toWorkerId: d.to, allowed: [...d.allowed], at: event.at };
      return { ...state, notes: [...state.notes, note] }; // the card keeps its assignee and status
    }
    case "card.question_opened": {
      const d = event.data;
      const asking = state.cards.find((c) => c.id === d.askingCardId)!;
      const card: CardState = {
        id: d.id, projectId: event.projectId!, number: d.number, kind: "question", title: d.text.slice(0, 200), todo: "", status: "todo",
        assigneeId: null, anchorKey: asking.anchorKey, anchorVersion: asking.anchorVersion, specChangedVersion: null,
        question: { text: d.text, proposedDefault: d.proposedDefault, cases: [...d.cases] }, answer: null, createdAt: event.at, updatedAt: event.at,
      };
      return { ...state, cards: [...state.cards, card], deps: [...state.deps, { cardId: d.askingCardId, dependsOnId: d.id }] };
    }
    case "card.question_answered":
      return { ...state, cards: touch(state.cards, event.data.cardId, event.at, { answer: event.data.answer, status: "done" }) };
    case "card.spec_change_cleared":
      return { ...state, cards: touch(state.cards, event.data.cardId, event.at, { specChangedVersion: null }) };
    case "card.spec_changed": {
      const { version, cardIds } = event.data;
      return {
        ...state,
        // the pull applies versions oldest first, so the version in the event is the newest one seen: it wins (R8);
        // the anchor itself is never edited
        cards: state.cards.map((c) => (cardIds.includes(c.id) ? { ...c, specChangedVersion: version, updatedAt: event.at } : c)),
        project: state.project && { ...state.project, latestSeenVersion: version },
      };
    }
    // R6: switching never resets anything — only the mode (and a budget, when one is sent) changes
    case "project.mode_set":
      return { ...state, project: state.project && { ...state.project, mode: event.data.mode, hopBudget: event.data.hopBudget ?? state.project.hopBudget } };
    case "project.workspace_set":
      return { ...state, project: state.project && { ...state.project, workspace: { roots: [...event.data.roots] } } };
    case "run.started": {
      const d = event.data;
      return { ...state, runs: [...state.runs, { id: d.id, projectId: event.projectId!, mode: d.mode, hopBudget: d.hopBudget, startedAt: event.at, endedAt: null, stopReason: null, report: null }] };
    }
    case "run.finished":
      return { ...state, runs: state.runs.map((r) => (r.id === event.data.runId ? { ...r, endedAt: event.at, stopReason: event.data.stopReason, report: event.data.report } : r)) };
    case "hop.started": {
      const d = event.data;
      const hop: HopState = {
        id: d.id, projectId: event.projectId!, runId: d.runId, claimedBy: d.claim, cardId: d.cardId, messageId: d.messageId, locatedKeys: null, workerId: d.workerId,
        startedAt: event.at, endedAt: null, outcome: null, tokensIn: null, tokensOut: null, note: "",
      };
      // the runner has picked a retry up: the next hop on the message clears the request (v1.9)
      const chat = d.messageId === null ? state.chat : state.chat.map((m) => (m.id === d.messageId && m.retryRequestedAt !== null ? { ...m, retryRequestedAt: null } : m));
      return { ...state, hops: [...state.hops, hop], chat };
    }
    // the keys a chat hop located — never the spec text (REQ-010 R1); each locate adds, order kept, no repeats (v1.6)
    case "hop.located":
      return { ...state, hops: state.hops.map((h) => (h.id === event.data.hopId ? { ...h, locatedKeys: [...new Set([...(h.locatedKeys ?? []), ...event.data.keys])] } : h)) };
    case "chat.posted": {
      const m: ChatMessageState = { id: event.data.id, projectId: event.projectId!, author: event.actor, text: event.data.text, replyTo: null, replyHopId: null, questions: null, proposalId: null, amendment: null, at: event.at, retryRequestedAt: null };
      return { ...state, chat: [...state.chat, m] };
    }
    case "chat.replied": {
      const d = event.data;
      const m: ChatMessageState = { id: d.id, projectId: event.projectId!, author: event.actor, text: d.text, replyTo: d.messageId, replyHopId: null, questions: d.questions, proposalId: d.proposalId, amendment: d.amendment, at: event.at, retryRequestedAt: null };
      return { ...state, chat: [...state.chat.map((x) => (x.id === d.messageId ? { ...x, replyHopId: d.hopId } : x)), m] };
    }
    case "chat.retry_requested":
      return { ...state, chat: state.chat.map((m) => (m.id === event.data.messageId ? { ...m, retryRequestedAt: event.at } : m)) };
    case "proposal.made": {
      const d = event.data;
      const p: ProposalState = { id: d.id, projectId: event.projectId!, messageId: d.messageId, version: d.version, items: d.items, status: "open", cardIds: null, createdAt: event.at };
      return { ...state, proposals: [...state.proposals.map((x) => (d.supersedes.includes(x.id) ? { ...x, status: "superseded" as const } : x)), p] };
    }
    case "proposal.accepted":
      return { ...state, proposals: state.proposals.map((p) => (p.id === event.data.proposalId ? { ...p, status: "accepted" as const, cardIds: [...event.data.cardIds] } : p)) };
    case "hop.claimed":
      return { ...state, hops: state.hops.map((h) => (h.id === event.data.hopId ? { ...h, claimedBy: event.data.claim } : h)) };
    case "hop.finished": {
      const d = event.data;
      return {
        ...state,
        hops: state.hops.map((h) => (h.id === d.hopId ? { ...h, endedAt: event.at, outcome: d.outcome, tokensIn: d.tokensIn, tokensOut: d.tokensOut, note: d.note } : h)),
        // every finished CARD hop counts, an interrupted one too (it started and may have done work — C-Q1); a chat hop never does (v1.8)
        project: state.project && state.hops.find((h) => h.id === d.hopId)?.messageId === null
          ? { ...state.project, hopsUsed: state.project.hopsUsed + 1 }
          : state.project,
      };
    }
  }
}
