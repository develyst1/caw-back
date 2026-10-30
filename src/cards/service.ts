// Cards (SPEC-A-008 § API): a card is work anchored to a part of a confirmed Blueprint version — { key, version } and nothing
// of the spec itself. Each write is one event decided inside the write transaction on the project's current state.
import { eq } from "drizzle-orm";
import type { Blueprint } from "../blueprint/client";
import { labelOf, pinnedRead, readLatestPart, type LatestRead } from "../blueprint/latest";
import type { Actor, CardStatus } from "../core/events";
import { newId, now } from "../core/ids";
import { rewriteForActor } from "../core/paths";
import type { CardState, CodeMapState, State } from "../core/reduce";
import { isUuid, loadState } from "../core/state";
import { writeDecided } from "../core/write";
import type { Db } from "../db/client";
import { cards } from "../db/schema";
import { requireOperator, workerIdOf } from "../http/actor";
import { ApiError, notFound } from "../http/errors";
import { type Card, cardView, depsOf, isWorkable, type Note, noteView } from "./view";

const need = <T>(x: T | null | undefined, what: string): T => x ?? (() => { throw notFound(what); })();
const projectState = async (db: Db, projectId: string) => {
  const s = await loadState(db, projectId);
  need(s.project, "project");
  return s;
};
/** A card's project is found from its id alone (cards never move between projects). */
async function findCard(db: Db, cardId: string): Promise<{ projectId: string; state: State; card: CardState }> {
  const [row] = isUuid(cardId) ? await db.select({ projectId: cards.projectId }).from(cards).where(eq(cards.id, cardId)) : [];
  const projectId = need(row, "card").projectId;
  const state = await loadState(db, projectId);
  return { projectId, state, card: need(state.cards.find((c) => c.id === cardId), "card") };
}
const cardIn = (s: State, cardId: string) => need(s.cards.find((c) => c.id === cardId), "card");

/** v1.5 (D-054): a `worker:<id>` writes on a card only from a RUNNING hop of its own on that card (`X-CAW-Hop`). operator / runner: no hop. */
function guardHop(s: State, actor: Actor, hopId: string | null, card: CardState): void {
  const wid = workerIdOf(actor);
  if (wid === null) return;
  if (hopId === null) throw new ApiError(400, "hop_required", "a worker writes only from a running hop: send X-CAW-Hop with the id of your hop on this card");
  const hop = s.hops.find((h) => h.id === hopId);
  if (!hop || hop.workerId !== wid || hop.cardId !== card.id || hop.endedAt !== null) {
    throw new ApiError(409, "hop_not_running", "that hop is not a running hop of yours on this card", { hopId, endedAt: hop?.endedAt ?? null, outcome: hop?.outcome ?? null });
  }
}

/** The operator may act on any card; a worker only on a card assigned to it (SPEC § Identity). */
function mayAct(actor: Actor, card: CardState): void {
  const wid = workerIdOf(actor);
  if (wid !== null && card.assigneeId !== wid) throw new ApiError(403, "not_your_card", "that card is not assigned to you");
}
const notMember = (id: string) => new ApiError(400, "not_a_member", `worker ${id} is not in this project's chain`);

// ---------- create / read ----------
export async function createCard(db: Db, blueprint: Blueprint, actor: Actor, projectId: string,
  input: { title: string; todo: string; anchor?: { key: string; version?: number }; assigneeId?: string; dependsOn?: string[] }): Promise<Card> {
  requireOperator(actor);
  if (!input.anchor) throw new ApiError(400, "anchor_required", "a card needs an anchor: { key } — a part of Blueprint's current spec");
  const { project } = await projectState(db, projectId);
  // REQ-105 (SPEC-107 D2/D4): the anchor is the key; CAW sets the rest from what Blueprint shows NOW — the label number (0 = none) and words, and the spec revision. A `version` in the
  // body is ignored. The key must be live in the current spec (422 anchor_not_in_version); the read is outside the write lock (a network call).
  const read = await readLatestPart(db, blueprint, project!, input.anchor.key);
  if (read === null) throw new ApiError(422, "anchor_not_in_version", `${input.anchor.key} is not a part of Blueprint's current spec`);
  const label = labelOf(read.body);
  const anchor = { key: input.anchor.key, version: label.version, label: label.label, revision: read.revision };
  const id = newId();
  const { state } = await writeDecided(db, projectId, (s) => {
    need(s.project, "project");
    if (input.assigneeId !== undefined && !s.members.includes(input.assigneeId)) throw notMember(input.assigneeId);
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    for (const d of dependsOn) if (!s.cards.some((c) => c.id === d)) throw new ApiError(400, "validation", `dependsOn: ${d} is not a card of this project`);
    return { type: "card.created", projectId, actor, at: now(), data: {
      id, number: Math.max(0, ...s.cards.map((c) => c.number)) + 1, title: input.title, todo: input.todo, anchor, assigneeId: input.assigneeId ?? null, dependsOn,
    } };
  });
  return cardView(state, cardIn(state, id));
}

export async function listCards(db: Db, projectId: string, q: { assigneeId?: string; status?: CardStatus; workable?: boolean }): Promise<Card[]> {
  const s = await projectState(db, projectId);
  return s.cards
    .filter((c) => (q.assigneeId === undefined || c.assigneeId === q.assigneeId) && (q.status === undefined || c.status === q.status) && (!q.workable || isWorkable(s, c)))
    .sort((a, b) => a.number - b.number).map((c) => cardView(s, c));
}

export async function getCard(db: Db, cardId: string): Promise<Card> {
  const { state, card } = await findCard(db, cardId);
  return cardView(state, card);
}

/** REQ-105: where `spec` came from — the spec revision, when CAW read it, whether Blueprint was unreachable and the last body read was served, and whether it is the text the hop was pinned with */
export type SpecRead = { revision: number; readAt: string; fromCache: boolean; pinned: boolean };
export type CardContext = { card: Card; spec: unknown; specRead: SpecRead; notes: Note[]; decisions: { cardId: string; number: number; question: string; answer: string }[]; codeMap: CodeMapState | null };

// spec = Blueprint's v2 part context exactly as returned (no reshaping). notes oldest first. decisions = the answered question
// cards this card depends on directly (SPEC A-1, Interpreted).
// REQ-105 D5: a worker reading its OWN running-or-finished card hop's card with that hop's `X-CAW-Hop` gets the text the hop was pinned with at its start (AC-2), even after the spec moved on.
// Any other caller — the operator, a worker reading another card, a hop with no pin — gets the latest read (D4), which falls back to the last body read when Blueprint is down (AC-5).
export async function cardContext(db: Db, blueprint: Blueprint, cardId: string, actor: Actor, hopId: string | null): Promise<CardContext> {
  const { state, card } = await findCard(db, cardId);
  const wid = workerIdOf(actor);
  const hop = hopId === null || wid === null ? undefined : state.hops.find((h) => h.id === hopId && h.cardId === card.id && h.workerId === wid);
  const pinned: LatestRead | null = hop ? await pinnedRead(db, hop.id) : null;
  // REQ-105 D12 (Q4): a removed anchor part is its own answer — 404 `anchor_removed`, not an outage. A worker's own pinned hop still gets its pinned text (D5 wins, above).
  const removed = () => new ApiError(404, "anchor_removed", `part ${card.anchorKey} was removed from the spec`);
  if (pinned === null && card.anchorRemovedRevision !== null) throw removed();
  const read = pinned ?? await readLatestPart(db, blueprint, state.project!, card.anchorKey);
  // The part is no longer in the current spec but the pull has not seen it yet: the same answer.
  if (read === null) throw removed();
  return {
    card: cardView(state, card), spec: read.body,
    specRead: { revision: read.revision, readAt: read.readAt, fromCache: read.fromCache, pinned: pinned !== null },
    notes: state.notes.filter((n) => n.cardId === cardId).sort((a, b) => (a.id < b.id ? -1 : 1)).map(noteView),
    decisions: depsOf(state, cardId).filter((d) => d.kind === "question" && d.answer !== null)
      .map((d) => ({ cardId: d.id, number: d.number, question: d.question!.text, answer: d.answer! })),
    codeMap: state.project!.codeMap, // v1.16: every card hop knows the folders
  };
}

// ---------- writes on a card ----------
// One shape: find the card's project, then decide inside the write transaction on that project's current state.
async function onCard(db: Db, cardId: string, decide: (s: State, card: CardState) => ReturnType<Parameters<typeof writeDecided>[2]>): Promise<{ state: State; card: CardState }> {
  const { projectId } = await findCard(db, cardId);
  const { state } = await writeDecided(db, projectId, (s) => decide(s, cardIn(s, cardId)));
  return { state, card: cardIn(state, cardId) };
}

export async function addComment(db: Db, actor: Actor, hopId: string | null, cardId: string, text: string): Promise<Note> {
  await findCard(db, cardId); // 404 before 403
  const noteId = newId();
  const { state } = await onCard(db, cardId, (s, card) => {
    guardHop(s, actor, hopId, card);
    mayAct(actor, card);
    return { type: "card.commented", projectId: card.projectId, actor, at: now(), data: { cardId, noteId, text: rewriteForActor(actor, text, s.project!.workspace.roots) } }; // v1.16: a worker's machine paths out
  });
  return noteView(state.notes.find((n) => n.id === noteId)!);
}

// A hand-off follows an edge of the project's chain: from the card's current assignee to a worker it may hand to.
export async function handOff(db: Db, actor: Actor, hopId: string | null, cardId: string, toWorkerId: string, text: string): Promise<Card> {
  const { projectId } = await findCard(db, cardId);
  const noteId = newId();
  try {
    const { state, card } = await onCard(db, cardId, (s, c) => {
      guardHop(s, actor, hopId, c); // before the refusal record: a hand-off from a hop that is not running is not recorded
      mayAct(actor, c);
      const allowed = s.edges.filter((e) => e.from === c.assigneeId).map((e) => e.to);
      if (!allowed.includes(toWorkerId)) throw new ApiError(409, "chain_broken", "the chain has no hand-off from the card's worker to that worker", { from: c.assigneeId, allowed });
      return { type: "card.handed_off", projectId: c.projectId, actor, at: now(), data: { cardId, fromWorkerId: c.assigneeId, toWorkerId, noteId, text } };
    });
    return cardView(state, card);
  } catch (e) {
    // v1.3 (D-051): a hand-off refused `chain_broken` is recorded — one event, its own transaction — and the 409 is answered unchanged.
    // Only this refusal: not_your_card, a 400 and a 404 write nothing.
    if (e instanceof ApiError && e.code === "chain_broken") await recordRefusedHandOff(db, projectId, actor, { cardId, noteId, toWorkerId, text, details: e.details as { from: string | null; allowed: string[] } });
    throw e; // the caller always gets the 409
  }
}

// The note names who the card was to go to, so `to` must be a worker CAW knows (notes.to_worker_id is a foreign key): a hand-off to
// an id that is no worker is refused as before and leaves no note. A failure to record never replaces the 409 — it is logged
// (name and code only) and the 409 goes out.
async function recordRefusedHandOff(db: Db, projectId: string, actor: Actor,
  r: { cardId: string; noteId: string; toWorkerId: string; text: string; details: { from: string | null; allowed: string[] } }): Promise<void> {
  const unknown = Symbol("unknown worker");
  try {
    await writeDecided(db, projectId, (s) => {
      if (!s.workers.some((w) => w.id === r.toWorkerId && w.deletedAt === null)) throw unknown; // a deleted worker is unknown too (v1.14)
      return { type: "card.handoff_refused", projectId, actor, at: now(), data: { cardId: r.cardId, noteId: r.noteId, from: r.details.from, to: r.toWorkerId, allowed: r.details.allowed, text: r.text } };
    });
  } catch (e) {
    if (e === unknown) return;
    const code = (e as { cause?: { code?: string } }).cause?.code;
    console.error(`[handoff] refusal not recorded ${(e as Error).name}${code ? ` code=${code}` : ""}`);
  }
}

export async function setStatus(db: Db, actor: Actor, hopId: string | null, cardId: string, status: CardStatus): Promise<Card> {
  await findCard(db, cardId);
  const { state, card } = await onCard(db, cardId, (s, c) => {
    guardHop(s, actor, hopId, c);
    mayAct(actor, c);
    if (c.kind === "question") throw new ApiError(400, "validation", "a question card is answered (POST …/answer), not moved");
    if (status === "doing" && depsOf(s, c.id).some((d) => d.status !== "done")) {
      throw new ApiError(409, "waiting_on_question", "a card this one depends on is not done yet");
    }
    return { type: "card.status_set", projectId: c.projectId, actor, at: now(), data: { cardId, status } };
  });
  return cardView(state, card);
}

// The operator's re-assign ignores the chain (the operator's authority); a worker's hand-off must follow an edge.
export async function assign(db: Db, actor: Actor, cardId: string, workerId: string): Promise<Card> {
  requireOperator(actor);
  await findCard(db, cardId);
  const { state, card } = await onCard(db, cardId, (s, c) => {
    if (c.kind === "question") throw new ApiError(400, "validation", "a question card has no assignee — the operator answers it");
    if (!s.members.includes(workerId)) throw notMember(workerId);
    return { type: "card.assigned", projectId: c.projectId, actor, at: now(), data: { cardId, workerId } };
  });
  return cardView(state, card);
}

// A question card (assignee null = the operator) is made in the same event as the dependency asking-card → question-card.
export async function askQuestion(db: Db, actor: Actor, hopId: string | null, cardId: string, q: { text: string; proposedDefault: string; cases: string[] }): Promise<Card> {
  await findCard(db, cardId);
  const id = newId();
  const { state } = await onCard(db, cardId, (s, c) => {
    guardHop(s, actor, hopId, c);
    mayAct(actor, c);
    if (c.kind === "question") throw new ApiError(400, "validation", "a question card cannot ask a question");
    return { type: "card.question_opened", projectId: c.projectId, actor, at: now(), data: {
      askingCardId: cardId, id, number: Math.max(0, ...s.cards.map((x) => x.number)) + 1,
      text: rewriteForActor(actor, q.text, s.project!.workspace.roots), proposedDefault: rewriteForActor(actor, q.proposedDefault, s.project!.workspace.roots),
      cases: q.cases.map((x) => rewriteForActor(actor, x, s.project!.workspace.roots)), // v1.16: the question is read by the operator
    } };
  });
  return cardView(state, cardIn(state, id));
}

export async function answerQuestion(db: Db, actor: Actor, cardId: string, answer: string): Promise<Card> {
  requireOperator(actor);
  await findCard(db, cardId);
  const { state, card } = await onCard(db, cardId, (_s, c) => {
    if (c.kind !== "question") throw new ApiError(400, "not_a_question", "only a question card can be answered");
    if (c.answer !== null) throw new ApiError(409, "already_answered", "that question already has an answer");
    return { type: "card.question_answered", projectId: c.projectId, actor, at: now(), data: { cardId, answer } };
  });
  return cardView(state, card);
}

/** The operator has seen the changed spec and says the card may go on. Nothing to clear → the card as it is, no event. */
export async function clearSpecChange(db: Db, actor: Actor, cardId: string): Promise<Card> {
  requireOperator(actor);
  const found = await findCard(db, cardId);
  if (found.card.specChangedVersion === null) return cardView(found.state, found.card);
  const { state, card } = await onCard(db, cardId, (_s, c) => ({ type: "card.spec_change_cleared", projectId: c.projectId, actor, at: now(), data: { cardId } }));
  return cardView(state, card);
}
