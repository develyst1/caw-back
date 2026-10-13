// A card as the API shows it (SPEC-A-008 § Shapes), derived from a project's State. `workable` is computed, never stored:
// a work card in todo / doing whose dependencies are all done and whose spec has not changed under it.
import type { CardStatus } from "../core/events";
import type { CardState, NoteState, State } from "../core/reduce";

export type Card = {
  id: string; projectId: string; number: number; kind: "work" | "question"; title: string; todo: string; status: CardStatus;
  assigneeId: string | null; anchor: { key: string; version: number }; specChangedVersion: number | null; dependsOn: string[];
  question: { text: string; proposedDefault: string; cases: string[] } | null; answer: string | null; workable: boolean;
  createdAt: string; updatedAt: string;
};
export type Note = { id: string; type: "comment" | "handoff"; actor: string; text: string; fromWorkerId: string | null; toWorkerId: string | null; at: string };

export const depsOf = (s: State, cardId: string): CardState[] => {
  const ids = new Set(s.deps.filter((d) => d.cardId === cardId).map((d) => d.dependsOnId));
  return s.cards.filter((c) => ids.has(c.id)).sort((a, b) => a.number - b.number);
};

export const isWorkable = (s: State, c: CardState): boolean =>
  c.kind === "work" && (c.status === "todo" || c.status === "doing") && c.specChangedVersion === null && depsOf(s, c.id).every((d) => d.status === "done");

export const cardView = (s: State, c: CardState): Card => ({
  id: c.id, projectId: c.projectId, number: c.number, kind: c.kind, title: c.title, todo: c.todo, status: c.status, assigneeId: c.assigneeId,
  anchor: { key: c.anchorKey, version: c.anchorVersion }, specChangedVersion: c.specChangedVersion, dependsOn: depsOf(s, c.id).map((d) => d.id),
  question: c.question, answer: c.answer, workable: isWorkable(s, c), createdAt: c.createdAt, updatedAt: c.updatedAt,
});

export const noteView = (n: NoteState): Note =>
  ({ id: n.id, type: n.type, actor: n.actor, text: n.text, fromWorkerId: n.fromWorkerId, toWorkerId: n.toWorkerId, at: n.at });
