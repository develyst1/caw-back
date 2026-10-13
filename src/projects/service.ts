// Projects (SPEC-A-008 § API): made from a confirmed Blueprint version; CAW keeps ids and numbers, never spec content.
import { asc, desc, sql } from "drizzle-orm";
import type { Blueprint } from "../blueprint/client";
import { rebuildCheck } from "../core/rebuild";
import type { ProjectState } from "../core/reduce";
import { loadState } from "../core/state";
import { writeDecided, writeEvent } from "../core/write";
import type { Actor, Mode } from "../core/events";
import { now } from "../core/ids";
import type { Db } from "../db/client";
import { cards, events, projects } from "../db/schema";
import { requireOperator } from "../http/actor";
import { ApiError, notFound } from "../http/errors";

export type Project = ProjectState;
export type ProjectSummary = Project & { cardsDone: number; cardsTotal: number; stuckCount: number };

export async function createProject(db: Db, blueprint: Blueprint, actor: Actor, input: { blueprintProjectId: string; version: number }): Promise<Project> {
  const bp = await blueprint.getProject(input.blueprintProjectId);
  if (!bp) throw new ApiError(404, "blueprint_project_not_found", `Blueprint has no project ${input.blueprintProjectId}`);
  if (!(await blueprint.getVersion(input.blueprintProjectId, input.version))) {
    throw new ApiError(409, "version_not_confirmed", `version ${input.version} of that Blueprint project is not a confirmed version`);
  }
  const [existing] = await db.select({ id: projects.id }).from(projects)
    .where(sql`${projects.blueprintProjectId} = ${input.blueprintProjectId} and ${projects.version} = ${input.version}`);
  if (existing) throw new ApiError(409, "already_exists", "a CAW project already exists for that version", { id: existing.id });
  const id = crypto.randomUUID();
  const { state } = await writeEvent(db, {
    type: "project.created", projectId: id, actor, at: new Date().toISOString(),
    data: { id, name: bp.name, blueprintProjectId: input.blueprintProjectId, version: input.version },
  });
  return state.project!;
}

const projectIn = (s: { project: Project | null }) => s.project ?? (() => { throw notFound("project"); })();

// R6: switching the mode never touches hopsUsed, cards or hops; a budget is set only when one is sent.
export async function setMode(db: Db, actor: Actor, projectId: string, input: { mode: Mode; hopBudget?: number }): Promise<Project> {
  requireOperator(actor);
  const { state } = await writeDecided(db, projectId, (s) => {
    projectIn(s);
    return { type: "project.mode_set", projectId, actor, at: now(), data: { mode: input.mode, hopBudget: input.hopBudget ?? null } };
  });
  return state.project!;
}

export async function setWorkspace(db: Db, actor: Actor, projectId: string, roots: string[]): Promise<Project> {
  requireOperator(actor);
  const { state } = await writeDecided(db, projectId, (s) => {
    projectIn(s);
    return { type: "project.workspace_set", projectId, actor, at: now(), data: { roots } };
  });
  return state.project!;
}

export async function getProject(db: Db, id: string): Promise<Project> {
  const { project } = await loadState(db, id);
  if (!project) throw notFound("project");
  return project;
}

// stuck = status `stuck`, or an open question card, or a card whose spec changed under it — never a finished (done) card; each card counted once
export async function listProjects(db: Db): Promise<ProjectSummary[]> {
  const rows = await db.select({ id: projects.id }).from(projects).orderBy(desc(projects.createdAt), asc(projects.id)); // newest first, as Blueprint lists
  const counts = await db.select({
    projectId: cards.projectId,
    total: sql<number>`count(*)::int`,
    done: sql<number>`count(*) filter (where ${cards.status} = 'done')::int`,
    stuck: sql<number>`count(*) filter (where ${cards.status} = 'stuck' or (${cards.kind} = 'question' and ${cards.status} <> 'done') or (${cards.specChangedVersion} is not null and ${cards.status} <> 'done'))::int`,
  }).from(cards).groupBy(cards.projectId);
  const byProject = new Map(counts.map((c) => [c.projectId, c]));
  return Promise.all(rows.map(async ({ id }) => {
    const c = byProject.get(id);
    return { ...(await getProject(db, id)), cardsDone: c?.done ?? 0, cardsTotal: c?.total ?? 0, stuckCount: c?.stuck ?? 0 };
  }));
}

export async function listEvents(db: Db, projectId: string, after: number, limit: number) {
  await getProject(db, projectId);
  const rows = await db.select().from(events).where(sql`${events.projectId} = ${projectId} and ${events.seq} > ${after}`).orderBy(asc(events.seq)).limit(limit);
  return rows.map((e) => ({ seq: e.seq, projectId: e.projectId, type: e.type, actor: e.actor, at: e.at.toISOString(), data: e.data }));
}

export async function checkRebuild(db: Db, projectId: string) {
  await getProject(db, projectId);
  return rebuildCheck(db, projectId);
}
