// Workers (SPEC-A-008 § Data model, Defaults): global, named, with skills, a model and an effort. A combined worker is a
// new worker built from two (the originals stay).
import type { Actor } from "../core/events";
import { newId, now } from "../core/ids";
import type { WorkerState } from "../core/reduce";
import { writeDecided } from "../core/write";
import { loadState } from "../core/state";
import type { Db } from "../db/client";
import { requireOperator } from "../http/actor";
import { ApiError, notFound } from "../http/errors";

export type Role = "PM" | "SA" | "FE" | "BE" | "QA" | "other";
export type Model = "opus" | "sonnet" | "haiku";
export type Effort = "low" | "medium" | "high";

// REQ-010 R5 / IDEA.md §3: PM · SA · QA think harder; FE · BE · other are the cheaper default.
const DEFAULTS: Record<Role, [Model, Effort]> = {
  PM: ["opus", "medium"], SA: ["opus", "medium"], QA: ["opus", "medium"], FE: ["sonnet", "medium"], BE: ["sonnet", "medium"], other: ["sonnet", "medium"],
};
const MODELS: Model[] = ["haiku", "sonnet", "opus"]; // weakest → strongest
const EFFORTS: Effort[] = ["low", "medium", "high"];

export type Worker = { id: string; name: string; role: Role; skills: string[]; model: Model; effort: Effort; combinedFrom: string[] | null };
export const workerView = (w: WorkerState): Worker =>
  ({ id: w.id, name: w.name, role: w.role as Role, skills: w.skills, model: w.model as Model, effort: w.effort as Effort, combinedFrom: w.combinedFrom });

const taken = (name: string) => new ApiError(409, "name_taken", `a worker named "${name}" already exists`);

export async function createWorker(db: Db, actor: Actor, input: { name: string; role: Role; skills: string[]; model?: Model; effort?: Effort }): Promise<Worker> {
  requireOperator(actor);
  const id = newId();
  const { state } = await writeDecided(db, null, (s) => {
    if (s.workers.some((w) => w.name === input.name)) throw taken(input.name);
    const [model, effort] = DEFAULTS[input.role];
    return { type: "worker.created", projectId: null, actor, at: now(),
      data: { id, name: input.name, role: input.role, skills: input.skills, model: input.model ?? model, effort: input.effort ?? effort } };
  });
  return workerView(state.workers.find((w) => w.id === id)!);
}

// Combine (Interpreted, reversible): skills = union (order kept, no repeats), the stronger model, the higher effort, role other.
export async function combineWorkers(db: Db, actor: Actor, input: { name: string; workerIds: [string, string] }): Promise<Worker> {
  requireOperator(actor);
  const id = newId();
  const { state } = await writeDecided(db, null, (s) => {
    const [a, b] = input.workerIds.map((wid) => s.workers.find((w) => w.id === wid) ?? (() => { throw notFound("worker"); })());
    if (s.workers.some((w) => w.name === input.name)) throw taken(input.name);
    const stronger = <T extends string>(order: T[], x: string, y: string) => order[Math.max(order.indexOf(x as T), order.indexOf(y as T))]!;
    return { type: "worker.combined", projectId: null, actor, at: now(), data: {
      id, name: input.name, role: "other", skills: [...new Set([...a!.skills, ...b!.skills])],
      model: stronger(MODELS, a!.model, b!.model), effort: stronger(EFFORTS, a!.effort, b!.effort), combinedFrom: [a!.id, b!.id],
    } };
  });
  return workerView(state.workers.find((w) => w.id === id)!);
}

export async function listWorkers(db: Db): Promise<Worker[]> {
  return (await loadState(db, null)).workers.map(workerView).sort((x, y) => (x.id < y.id ? -1 : 1));
}
