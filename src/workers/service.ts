// Workers (SPEC-A-008 § Data model, Defaults; § v1.10): global, named, with roles, skills, a model and an effort. A worker holds one or more
// roles (`roles`, in the order picked); `role` = roles[0] stays in every response, deprecated. A combined worker is a new worker built
// from two (the originals stay) — deprecated since v1.10, unchanged.
import { eq } from "drizzle-orm";
import type { Actor, Avatar, WorkerPatch } from "../core/events";
import { newId, now } from "../core/ids";
import type { WorkerState } from "../core/reduce";
import { writeDecided } from "../core/write";
import { isUuid, loadState } from "../core/state";
import type { Db } from "../db/client";
import { chainMembers } from "../db/schema";
import { requireOperator } from "../http/actor";
import { ApiError, notFound } from "../http/errors";

export type Role = "PM" | "BA" | "SA" | "FE" | "BE" | "QA" | "other";
export type Model = "opus" | "sonnet" | "haiku";
export type Effort = "low" | "medium" | "high";

// REQ-010 R5 / IDEA.md §3: PM · BA · SA · QA think harder; FE · BE · other are the cheaper default. (BA: v1.10, Interpreted from D-060's "PM + BA".)
const DEFAULTS: Record<Role, [Model, Effort]> = {
  PM: ["opus", "medium"], BA: ["opus", "medium"], SA: ["opus", "medium"], QA: ["opus", "medium"], FE: ["sonnet", "medium"], BE: ["sonnet", "medium"], other: ["sonnet", "medium"],
};
const MODELS: Model[] = ["haiku", "sonnet", "opus"]; // weakest → strongest
const EFFORTS: Effort[] = ["low", "medium", "high"];

export type Worker = { id: string; name: string; roles: Role[]; role: Role; skills: string[]; model: Model; effort: Effort; avatar: Avatar | null; deletedAt: string | null; combinedFrom: string[] | null };
export const workerView = (w: WorkerState): Worker =>
  ({ id: w.id, name: w.name, roles: w.roles as Role[], role: w.roles[0] as Role, skills: w.skills, model: w.model as Model, effort: w.effort as Effort, avatar: w.avatar, deletedAt: w.deletedAt, combinedFrom: w.combinedFrom });

/** v1.14: a deleted worker is unknown to every write, and their name is free again — only live workers count. */
export const isLive = (w: WorkerState): boolean => w.deletedAt === null;
const taken = (name: string) => new ApiError(409, "name_taken", `a worker named "${name}" already exists`);
const stronger = <T extends string>(order: T[], x: string, y: string) => order[Math.max(order.indexOf(x as T), order.indexOf(y as T))]!;

export async function createWorker(db: Db, actor: Actor, input: { name: string; roles: Role[]; skills: string[]; model?: Model; effort?: Effort; avatar?: Avatar | null }): Promise<Worker> {
  requireOperator(actor);
  const id = newId();
  const { state } = await writeDecided(db, null, (s) => {
    if (s.workers.some((w) => isLive(w) && w.name === input.name)) throw taken(input.name);
    // the default is the strongest of the picked roles' defaults (the same order as combine)
    const [model, effort] = input.roles.map((r) => DEFAULTS[r]).reduce(([m0, e0], [m1, e1]) => [stronger(MODELS, m0, m1), stronger(EFFORTS, e0, e1)] as [Model, Effort]);
    return { type: "worker.created", projectId: null, actor, at: now(),
      data: { id, name: input.name, roles: input.roles, skills: input.skills, model: input.model ?? model, effort: input.effort ?? effort,
        ...(input.avatar !== undefined ? { avatar: input.avatar } : {}) } }; // carried when sent (v1.12)
  });
  return workerView(state.workers.find((w) => w.id === id)!);
}

// Edit (v1.10): sets only what is sent — changing `roles` does not change model / effort / skills. The event carries only the fields sent.
export async function updateWorker(db: Db, actor: Actor, workerId: string, input: WorkerPatch): Promise<Worker> {
  requireOperator(actor);
  const { state } = await writeDecided(db, null, (s) => {
    if (!s.workers.some((w) => w.id === workerId && isLive(w))) throw notFound("worker");
    if (input.name !== undefined && s.workers.some((w) => isLive(w) && w.name === input.name && w.id !== workerId)) throw taken(input.name);
    const sent = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as WorkerPatch;
    return { type: "worker.updated", projectId: null, actor, at: now(), data: { id: workerId, ...sent } };
  });
  return workerView(state.workers.find((w) => w.id === workerId)!);
}

// Combine (Interpreted, reversible; deprecated in v1.10): skills = union (order kept, no repeats), the stronger model, the higher effort, roles [other].
export async function combineWorkers(db: Db, actor: Actor, input: { name: string; workerIds: [string, string] }): Promise<Worker> {
  requireOperator(actor);
  const id = newId();
  const { state } = await writeDecided(db, null, (s) => {
    const [a, b] = input.workerIds.map((wid) => s.workers.find((w) => w.id === wid && isLive(w)) ?? (() => { throw notFound("worker"); })());
    if (s.workers.some((w) => isLive(w) && w.name === input.name)) throw taken(input.name);
    return { type: "worker.combined", projectId: null, actor, at: now(), data: {
      id, name: input.name, roles: ["other"], skills: [...new Set([...a!.skills, ...b!.skills])],
      model: stronger(MODELS, a!.model, b!.model), effort: stronger(EFFORTS, a!.effort, b!.effort), combinedFrom: [a!.id, b!.id],
    } };
  });
  return workerView(state.workers.find((w) => w.id === id)!);
}

// Delete (v1.14, D-081): the worker is kept with deletedAt set. Refused while any project's chain has them — the chains are not in the
// workers-only state `writeDecided(db, null)` sees, so they are asked here, before the write (a chain add that lands in between is refused by
// addMember, which treats a deleted worker as unknown, but one that landed just before the delete event is not seen: one operator, accepted).
export async function deleteWorker(db: Db, actor: Actor, workerId: string): Promise<void> {
  requireOperator(actor);
  if (!isUuid(workerId)) throw notFound("worker");
  const inChains = await db.select({ projectId: chainMembers.projectId }).from(chainMembers).where(eq(chainMembers.workerId, workerId));
  if (inChains.length > 0) {
    throw new ApiError(409, "worker_in_chain", `the worker is in ${inChains.length} project chain(s) — take them out first`, { projectIds: [...new Set(inChains.map((r) => r.projectId))].sort() });
  }
  await writeDecided(db, null, (s) => {
    if (!s.workers.some((w) => w.id === workerId && isLive(w))) throw notFound("worker");
    return { type: "worker.deleted", projectId: null, actor, at: now(), data: { id: workerId } };
  });
}

export async function listWorkers(db: Db): Promise<Worker[]> {
  return (await loadState(db, null)).workers.map(workerView).sort((x, y) => (x.id < y.id ? -1 : 1));
}
