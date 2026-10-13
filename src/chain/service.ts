// A project's chain (SPEC-A-008 § API): who is in it, who may hand a card to whom (directed edges), who takes the first
// card (entry). Every chain write is the operator's.
import type { Actor } from "../core/events";
import { now } from "../core/ids";
import type { State } from "../core/reduce";
import { loadState } from "../core/state";
import { writeDecided } from "../core/write";
import type { Db } from "../db/client";
import { requireOperator } from "../http/actor";
import { ApiError, notFound } from "../http/errors";
import { type Worker, workerView } from "../workers/service";

export type Chain = { members: Worker[]; edges: { from: string; to: string }[]; entryWorkerId: string | null };

export const chainView = (s: State): Chain => ({
  members: s.workers.filter((w) => s.members.includes(w.id)).map(workerView).sort((x, y) => (x.id < y.id ? -1 : 1)),
  edges: [...s.edges].sort((x, y) => (`${x.from}|${x.to}` < `${y.from}|${y.to}` ? -1 : 1)),
  entryWorkerId: s.project!.entryWorkerId,
});

const notMember = (id: string) => new ApiError(400, "not_a_member", `worker ${id} is not in this project's chain`);
const project = (s: State) => s.project ?? (() => { throw notFound("project"); })();

export async function getChain(db: Db, projectId: string): Promise<Chain> {
  const s = await loadState(db, projectId);
  project(s);
  return chainView(s);
}

const write = async (db: Db, actor: Actor, projectId: string, decide: Parameters<typeof writeDecided>[2]) => {
  requireOperator(actor);
  return chainView((await writeDecided(db, projectId, decide)).state);
};

export const addMember = (db: Db, actor: Actor, projectId: string, workerId: string) => write(db, actor, projectId, (s) => {
  project(s);
  if (!s.workers.some((w) => w.id === workerId)) throw notFound("worker");
  if (s.members.includes(workerId)) throw new ApiError(409, "already_member", "that worker is already in the chain");
  return { type: "chain.member_added", projectId, actor, at: now(), data: { workerId } };
});

export const removeMember = (db: Db, actor: Actor, projectId: string, workerId: string, reassignTo: string | null) => write(db, actor, projectId, (s) => {
  const p = project(s);
  if (!s.members.includes(workerId)) throw notFound("chain member");
  if (p.entryWorkerId === workerId) throw new ApiError(409, "is_entry", "this worker is the chain's entry — set another entry first");
  const open = s.cards.filter((c) => c.assigneeId === workerId && c.status !== "done");
  if (reassignTo !== null) {
    if (reassignTo === workerId) throw new ApiError(400, "validation", "reassignTo must be another worker");
    if (!s.members.includes(reassignTo)) throw notMember(reassignTo);
  } else if (open.length > 0) {
    throw new ApiError(409, "has_open_cards", `${open.length} open card(s) are assigned to this worker — pass reassignTo`, { count: open.length });
  }
  return { type: "chain.member_removed", projectId, actor, at: now(), data: { workerId, reassignTo } };
});

export const addEdge = (db: Db, actor: Actor, projectId: string, from: string, to: string) => write(db, actor, projectId, (s) => {
  project(s);
  if (from === to) throw new ApiError(400, "validation", "an edge needs two different workers");
  for (const id of [from, to]) if (!s.members.includes(id)) throw notMember(id);
  if (s.edges.some((e) => e.from === from && e.to === to)) throw new ApiError(409, "edge_exists", "that hand-off edge already exists");
  return { type: "chain.edge_added", projectId, actor, at: now(), data: { from, to } };
});

export const removeEdge = (db: Db, actor: Actor, projectId: string, from: string, to: string) => write(db, actor, projectId, (s) => {
  project(s);
  if (!s.edges.some((e) => e.from === from && e.to === to)) throw notFound("edge");
  return { type: "chain.edge_removed", projectId, actor, at: now(), data: { from, to } };
});

export const setEntry = (db: Db, actor: Actor, projectId: string, workerId: string) => write(db, actor, projectId, (s) => {
  project(s);
  if (!s.members.includes(workerId)) throw notMember(workerId);
  return { type: "chain.entry_set", projectId, actor, at: now(), data: { workerId } };
});
