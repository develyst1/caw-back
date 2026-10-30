// A card as the API shows it (SPEC-A-008 § Shapes), derived from a project's State. `workable` is computed, never stored:
// a work card in todo / doing whose dependencies are all done and whose spec has not changed under it.
import type { CardStatus } from "../core/events";
import type { CardState, NoteState, State } from "../core/reduce";

export type Card = {
  id: string; projectId: string; number: number; kind: "work" | "question"; title: string; todo: string; status: CardStatus;
  assigneeId: string | null; anchor: { key: string; version: number }; /** REQ-105: the label's words when the card was cut; null = none */ anchorLabel: string | null; specChangedVersion: number | null; /** REQ-105 D12: the card's anchor part was removed from the spec — the card cannot be worked until it is moved or closed */ anchorRemoved: boolean; dependsOn: string[];
  question: { text: string; proposedDefault: string; cases: string[] } | null; answer: string | null; workable: boolean;
  /** SPEC-108 D7: why a card in `todo` is waiting to be picked up again; computed, never stored */
  stoppedMidway: { hopId: string; at: string; reason: string } | null;
  createdAt: string; updatedAt: string;
};
export type Note = {
  id: string; type: "comment" | "handoff" | "handoff_refused"; actor: string; text: string; fromWorkerId: string | null; toWorkerId: string | null;
  allowed: string[] | null; at: string;
};

export const depsOf = (s: State, cardId: string): CardState[] => {
  const ids = new Set(s.deps.filter((d) => d.cardId === cardId).map((d) => d.dependsOnId));
  return s.cards.filter((c) => ids.has(c.id)).sort((a, b) => a.number - b.number);
};

// REQ-105 D7 (PM's answer to Q2): the "spec changed" flag only SHOWS; it no longer stops a card, so the next hop goes on with the latest text. (`clear` stays, to dismiss the mark.)
// REQ-105 D12 (Q4): a card whose anchor part was REMOVED from the spec is not workable — there is no text to work from — until the part is back.
export const isWorkable = (s: State, c: CardState): boolean =>
  c.kind === "work" && c.anchorRemovedRevision === null && (c.status === "todo" || c.status === "doing") && depsOf(s, c.id).every((d) => d.status === "done");

/** D7: non-null when the card is `todo`, no hop on it is running, and its latest ENDED card hop (by start time) finished `failed`, `stopped` or `interrupted`.
 *  `reason` = that hop's note up to the first " · " (the leading sentence the runner writes). */
const stoppedMidway = (s: State, c: CardState): Card["stoppedMidway"] => {
  if (c.status !== "todo") return null;
  const hops = s.hops.filter((h) => h.cardId === c.id);
  if (hops.some((h) => h.endedAt === null)) return null;
  const last = hops.reduce<(typeof hops)[number] | null>((a, h) => (a === null || h.startedAt > a.startedAt || (h.startedAt === a.startedAt && h.id > a.id) ? h : a), null);
  if (last === null || last.endedAt === null || !(last.outcome === "failed" || last.outcome === "stopped" || last.outcome === "interrupted")) return null;
  return { hopId: last.id, at: last.endedAt, reason: last.note.split(" · ")[0]! };
};

export const cardView = (s: State, c: CardState): Card => ({
  id: c.id, projectId: c.projectId, number: c.number, kind: c.kind, title: c.title, todo: c.todo, status: c.status, assigneeId: c.assigneeId,
  anchor: { key: c.anchorKey, version: c.anchorVersion }, anchorLabel: c.anchorLabel, specChangedVersion: c.specChangedVersion, anchorRemoved: c.anchorRemovedRevision !== null, dependsOn: depsOf(s, c.id).map((d) => d.id),
  question: c.question, answer: c.answer, workable: isWorkable(s, c), stoppedMidway: stoppedMidway(s, c), createdAt: c.createdAt, updatedAt: c.updatedAt,
});

export const noteView = (n: NoteState): Note =>
  ({ id: n.id, type: n.type, actor: n.actor, text: n.text, fromWorkerId: n.fromWorkerId, toWorkerId: n.toWorkerId, allowed: n.allowed, at: n.at });
