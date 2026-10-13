// The one reducer: (state, event) → state. Pure — no I/O, no clock, no ids of its own (they are in the event).
// The write path applies it to the tables; a rebuild runs it over the stored events from `empty`. Same function, so the
// tables and a rebuild cannot disagree except by someone writing the tables behind the events' back (AC-6).
import type { CardStatus, CawEvent, HopOutcome, Mode, StopReason } from "./events";

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
  id: string; cardId: string; type: "comment" | "handoff"; actor: string; text: string;
  fromWorkerId: string | null; toWorkerId: string | null; at: string;
};
export type HopState = {
  id: string; projectId: string; runId: string | null; claimedBy: string | null; cardId: string; workerId: string;
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
};

export const empty: State = { project: null, workers: [], members: [], edges: [], cards: [], deps: [], notes: [], hops: [], runs: [] };

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
      const note: NoteState = { id: d.noteId, cardId: d.cardId, type: "handoff", actor: event.actor, text: d.text, fromWorkerId: d.fromWorkerId, toWorkerId: d.toWorkerId, at: event.at };
      return { ...state, cards: touch(state.cards, d.cardId, event.at, { assigneeId: d.toWorkerId }), notes: [...state.notes, note] };
    }
    case "card.commented": {
      const d = event.data;
      const note: NoteState = { id: d.noteId, cardId: d.cardId, type: "comment", actor: event.actor, text: d.text, fromWorkerId: null, toWorkerId: null, at: event.at };
      return { ...state, notes: [...state.notes, note] };
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
        id: d.id, projectId: event.projectId!, runId: d.runId, claimedBy: d.claim, cardId: d.cardId, workerId: d.workerId,
        startedAt: event.at, endedAt: null, outcome: null, tokensIn: null, tokensOut: null, note: "",
      };
      return { ...state, hops: [...state.hops, hop] };
    }
    case "hop.claimed":
      return { ...state, hops: state.hops.map((h) => (h.id === event.data.hopId ? { ...h, claimedBy: event.data.claim } : h)) };
    case "hop.finished": {
      const d = event.data;
      return {
        ...state,
        hops: state.hops.map((h) => (h.id === d.hopId ? { ...h, endedAt: event.at, outcome: d.outcome, tokensIn: d.tokensIn, tokensOut: d.tokensOut, note: d.note } : h)),
        // every finished hop counts, an interrupted one too (it started and may have done work — C-Q1)
        project: state.project && { ...state.project, hopsUsed: state.project.hopsUsed + 1 },
      };
    }
  }
}
