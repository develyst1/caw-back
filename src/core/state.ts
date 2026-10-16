// The tables ⇄ State. `loadState` reads one project's rows (and every worker) as a State; `saveState` writes what changed
// between two States. Only the reducer's output reaches the tables, and only through here.
import { and, eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { cardDeps, cards, chainEdges, chainMembers, chatMessages, hops, notes, projects, proposals, runs, workers } from "../db/schema";
import { stable } from "./stable";
import { empty, type CardState, type ChatMessageState, type HopState, type ProposalState, type NoteState, type ProjectState, type RunState, type State, type WorkerState } from "./reduce";

type Reader = Db | Tx;

/** An id that cannot be a uuid is no row (Postgres would raise on the cast): callers answer 404 / "not found". */
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const iso = (d: Date) => d.toISOString();
const projectOf = (r: typeof projects.$inferSelect): ProjectState => ({
  id: r.id, name: r.name, blueprintProjectId: r.blueprintProjectId, version: r.version, latestSeenVersion: r.latestSeenVersion,
  mode: r.mode as ProjectState["mode"], hopBudget: r.hopBudget, hopsUsed: r.hopsUsed, workspace: r.workspace,
  entryWorkerId: r.entryWorkerId, createdAt: iso(r.createdAt),
});
const workerOf = (r: typeof workers.$inferSelect): WorkerState => ({
  id: r.id, name: r.name, roles: r.roles, skills: r.skills, model: r.model, effort: r.effort, avatar: r.avatar ?? null, deletedAt: r.deletedAt && iso(r.deletedAt), combinedFrom: r.combinedFrom, createdAt: iso(r.createdAt),
});
const cardOf = (r: typeof cards.$inferSelect): CardState => ({
  id: r.id, projectId: r.projectId, number: r.number, kind: r.kind as CardState["kind"], title: r.title, todo: r.todo, status: r.status as CardState["status"],
  assigneeId: r.assigneeId, anchorKey: r.anchorKey, anchorVersion: r.anchorVersion, specChangedVersion: r.specChangedVersion,
  question: r.question as CardState["question"], answer: r.answer, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
});
const noteOf = (r: typeof notes.$inferSelect): NoteState => ({
  id: r.id, cardId: r.cardId, type: r.type as NoteState["type"], actor: r.actor, text: r.text,
  fromWorkerId: r.fromWorkerId, toWorkerId: r.toWorkerId, allowed: r.allowed ?? null, at: iso(r.at),
});

const hopOf = (r: typeof hops.$inferSelect): HopState => ({
  id: r.id, projectId: r.projectId, runId: r.runId, claimedBy: r.claimedBy, cardId: r.cardId, messageId: r.messageId, locatedKeys: r.locatedKeys, workerId: r.workerId, startedAt: iso(r.startedAt), lastActivityAt: iso(r.lastActivityAt),
  endedAt: r.endedAt && iso(r.endedAt), outcome: r.outcome as HopState["outcome"], tokensIn: r.tokensIn, tokensOut: r.tokensOut, note: r.note,
});
const runOf = (r: typeof runs.$inferSelect): RunState => ({
  id: r.id, projectId: r.projectId, mode: r.mode as RunState["mode"], hopBudget: r.hopBudget, startedAt: iso(r.startedAt),
  endedAt: r.endedAt && iso(r.endedAt), stopReason: r.stopReason as RunState["stopReason"], report: r.report,
});

const chatOf = (r: typeof chatMessages.$inferSelect): ChatMessageState => ({
  id: r.id, projectId: r.projectId, author: r.author, text: r.text, replyTo: r.replyTo, replyHopId: r.replyHopId,
  questions: r.questions as ChatMessageState["questions"], proposalId: r.proposalId, amendment: r.amendment as ChatMessageState["amendment"], at: iso(r.at),
  retryRequestedAt: r.retryRequestedAt && iso(r.retryRequestedAt),
});
const proposalOf = (r: typeof proposals.$inferSelect): ProposalState => ({
  id: r.id, projectId: r.projectId, messageId: r.messageId, version: r.version, items: r.items as ProposalState["items"],
  status: r.status as ProposalState["status"], cardIds: r.cardIds, createdAt: iso(r.createdAt),
});

/** `projectId` null = workers only (a worker-level write has no project). */
export async function loadState(db: Reader, projectId: string | null): Promise<State> {
  const allWorkers = (await db.select().from(workers)).map(workerOf);
  if (projectId === null || !isUuid(projectId)) return { ...empty, workers: allWorkers };
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!row) return { ...empty, workers: allWorkers };
  const cardRows = (await db.select().from(cards).where(eq(cards.projectId, projectId))).map(cardOf);
  const ids = cardRows.map((c) => c.id);
  return {
    project: projectOf(row),
    workers: allWorkers,
    members: (await db.select().from(chainMembers).where(eq(chainMembers.projectId, projectId))).map((m) => m.workerId),
    edges: (await db.select().from(chainEdges).where(eq(chainEdges.projectId, projectId))).map((e) => ({ from: e.fromWorkerId, to: e.toWorkerId })),
    cards: cardRows,
    deps: ids.length ? (await db.select().from(cardDeps).where(inArray(cardDeps.cardId, ids))).map((d) => ({ cardId: d.cardId, dependsOnId: d.dependsOnId })) : [],
    notes: ids.length ? (await db.select().from(notes).where(inArray(notes.cardId, ids))).map(noteOf) : [],
    hops: (await db.select().from(hops).where(eq(hops.projectId, projectId))).map(hopOf),
    runs: (await db.select().from(runs).where(eq(runs.projectId, projectId))).map(runOf),
    chat: (await db.select().from(chatMessages).where(eq(chatMessages.projectId, projectId))).map(chatOf),
    proposals: (await db.select().from(proposals).where(eq(proposals.projectId, projectId))).map(proposalOf),
  };
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);
/** what is new or changed in `after`, and what is gone, by key */
function diff<T>(before: T[], after: T[], key: (x: T) => string) {
  const old = new Map(before.map((x) => [key(x), x]));
  const now = new Map(after.map((x) => [key(x), x]));
  return {
    upsert: after.filter((x) => !same(old.get(key(x)), x)),
    removed: before.filter((x) => !now.has(key(x))),
  };
}

export async function saveState(tx: Tx, before: State, after: State): Promise<void> {
  // parents before children (foreign keys): workers → project → cards → chat → runs → hops → proposals → deps / notes → chain
  for (const w of diff(before.workers, after.workers, (w) => w.id).upsert) {
    const row = { ...w, createdAt: new Date(w.createdAt), deletedAt: w.deletedAt === null ? null : new Date(w.deletedAt) };
    await tx.insert(workers).values(row).onConflictDoUpdate({ target: workers.id, set: row });
  }
  if (after.project && !same(before.project, after.project)) {
    const row = { ...after.project, createdAt: new Date(after.project.createdAt) };
    await tx.insert(projects).values(row).onConflictDoUpdate({ target: projects.id, set: row });
  }
  for (const c of diff(before.cards, after.cards, (c) => c.id).upsert) {
    const row = { ...c, createdAt: new Date(c.createdAt), updatedAt: new Date(c.updatedAt) };
    await tx.insert(cards).values(row).onConflictDoUpdate({ target: cards.id, set: row });
  }
  const date = (s: string | null) => (s === null ? null : new Date(s));
  for (const m of diff(before.chat, after.chat, (m) => m.id).upsert) {
    const row = { ...m, at: new Date(m.at), retryRequestedAt: date(m.retryRequestedAt) };
    await tx.insert(chatMessages).values(row).onConflictDoUpdate({ target: chatMessages.id, set: row });
  }
  for (const r of diff(before.runs, after.runs, (r) => r.id).upsert) {
    const row = { ...r, startedAt: new Date(r.startedAt), endedAt: date(r.endedAt) };
    await tx.insert(runs).values(row).onConflictDoUpdate({ target: runs.id, set: row });
  }
  for (const h of diff(before.hops, after.hops, (h) => h.id).upsert) {
    const row = { ...h, startedAt: new Date(h.startedAt), lastActivityAt: new Date(h.lastActivityAt), endedAt: date(h.endedAt) };
    await tx.insert(hops).values(row).onConflictDoUpdate({ target: hops.id, set: row });
  }
  for (const p of diff(before.proposals, after.proposals, (p) => p.id).upsert) {
    const row = { ...p, createdAt: new Date(p.createdAt) };
    await tx.insert(proposals).values(row).onConflictDoUpdate({ target: proposals.id, set: row });
  }
  const depKey = (d: { cardId: string; dependsOnId: string }) => `${d.cardId}|${d.dependsOnId}`;
  const addedDeps = diff(before.deps, after.deps, depKey).upsert;
  if (addedDeps.length) await tx.insert(cardDeps).values(addedDeps);
  const addedNotes = diff(before.notes, after.notes, (n) => n.id).upsert;
  if (addedNotes.length) await tx.insert(notes).values(addedNotes.map((n) => ({ ...n, at: new Date(n.at) })));
  const project = after.project ?? before.project;
  if (project) {
    const members = diff(before.members, after.members, (m) => m);
    for (const workerId of members.removed) await tx.delete(chainMembers).where(and(eq(chainMembers.projectId, project.id), eq(chainMembers.workerId, workerId)));
    if (members.upsert.length) await tx.insert(chainMembers).values(members.upsert.map((workerId) => ({ projectId: project.id, workerId })));
    const edges = diff(before.edges, after.edges, (e) => `${e.from}|${e.to}`);
    for (const e of edges.removed) {
      await tx.delete(chainEdges).where(and(eq(chainEdges.projectId, project.id), eq(chainEdges.fromWorkerId, e.from), eq(chainEdges.toWorkerId, e.to)));
    }
    if (edges.upsert.length) await tx.insert(chainEdges).values(edges.upsert.map((e) => ({ projectId: project.id, fromWorkerId: e.from, toWorkerId: e.to })));
  }
}
