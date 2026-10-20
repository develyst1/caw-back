// Projects (SPEC-A-008 § API): made from a confirmed Blueprint version; CAW keeps ids and numbers, never spec content.
import { asc, desc, eq, sql } from "drizzle-orm";
import type { Blueprint } from "../blueprint/client";
import { rebuildCheck } from "../core/rebuild";
import type { CodeMapState, ProjectState } from "../core/reduce";
import { loadState } from "../core/state";
import { writeDecided, writeEvent } from "../core/write";
import { chatHopOf } from "../chat/guard";
import type { Actor, CodeMapInput, Mode } from "../core/events";
import { now } from "../core/ids";
import { rewriteForActor } from "../core/paths";
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
  // v1.15 (D-082): one CAW project per Blueprint project, at ANY version — a newer version is followed by the project that exists
  // (latestSeenVersion), not by a second project. Older duplicates may exist; the answer names the one with the highest version, then the newest.
  const [existing] = await db.select({ id: projects.id }).from(projects)
    .where(eq(projects.blueprintProjectId, input.blueprintProjectId)).orderBy(desc(projects.version), desc(projects.createdAt)).limit(1);
  if (existing) throw new ApiError(409, "already_exists", "a CAW project already exists for that Blueprint project", { id: existing.id });
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

// roots replace the list as a whole; readOnly (v1.16, D-100) ⊆ roots is checked at the route, default [] = "all writable"
export async function setWorkspace(db: Db, actor: Actor, projectId: string, input: { roots: string[]; readOnly?: string[] }): Promise<Project> {
  requireOperator(actor);
  const { state } = await writeDecided(db, projectId, (s) => {
    projectIn(s);
    return { type: "project.workspace_set", projectId, actor, at: now(), data: { roots: input.roots, readOnly: input.readOnly ?? [] } };
  });
  return state.project!;
}

// The setup step's result (v1.16, REQ-015 R2a, D-097): the ENTRY worker saves it from its running CHAT hop (v1.5's rules: 400 hop_required, 403
// not_your_message), then 403 not_entry_worker if the hop's worker is no longer the entry. Machine paths in every string are rewritten before it is stored
// (the event holds the clean text). Saving again replaces the map and clears confirmedAt. Written by a worker only — the operator has no hop.
export async function saveCodeMap(db: Db, actor: Actor, hopId: string | null, projectId: string, input: CodeMapInput): Promise<CodeMapState> {
  const { state } = await writeDecided(db, projectId, (s) => {
    const project = projectIn(s);
    const hop = chatHopOf(s, actor, hopId);
    if (project.entryWorkerId !== hop.workerId) throw new ApiError(403, "not_entry_worker", "only the project's entry worker saves the code map");
    const w = (t: string) => rewriteForActor(actor, t, project.workspace.roots);
    const map: CodeMapInput = {
      folders: input.folders.map((f) => ({ name: w(f.name), kind: f.kind, ...(f.note !== undefined ? { note: w(f.note) } : {}) })),
      stack: input.stack.map(w), commands: { run: input.commands.run.map(w), test: input.commands.test.map(w) }, rules: input.rules.map(w),
      questions: input.questions.map((q) => ({ text: w(q.text), proposedDefault: w(q.proposedDefault) })), ...(input.notes !== undefined ? { notes: w(input.notes) } : {}),
    };
    return { type: "project.code_map_saved", projectId, actor, at: now(), data: { ...map, hopId: hop.id } };
  });
  return state.project!.codeMap!;
}

class AlreadyConfirmed extends Error { constructor(readonly codeMap: CodeMapState) { super("already confirmed"); } } // rolls the (empty) write back

/** The operator has seen the code map and says it is right. None → 409 no_code_map; already confirmed → the map as it is, no event. */
export async function confirmCodeMap(db: Db, actor: Actor, projectId: string): Promise<CodeMapState> {
  requireOperator(actor);
  try {
    const { state } = await writeDecided(db, projectId, (s) => {
      const project = projectIn(s);
      if (project.codeMap === null) throw new ApiError(409, "no_code_map", "this project has no code map yet");
      if (project.codeMap.confirmedAt !== null) throw new AlreadyConfirmed(project.codeMap);
      return { type: "project.code_map_confirmed", projectId, actor, at: now(), data: {} };
    });
    return state.project!.codeMap!;
  } catch (e) {
    if (e instanceof AlreadyConfirmed) return e.codeMap;
    throw e;
  }
}

// v1.7: a read-only proxy to Blueprint's part context — one seam call, as returned, nothing stored (REQ-010 R1). `version` defaults
// to the project's latestSeenVersion. Blueprint has no such part (or no such version) → 404 part_not_found.
export async function readPart(db: Db, blueprint: Blueprint, projectId: string, key: string, version?: number): Promise<unknown> {
  const project = await getProject(db, projectId);
  const body = await blueprint.partContext(project.blueprintProjectId, version ?? project.latestSeenVersion, key);
  if (body === null) throw new ApiError(404, "part_not_found", `Blueprint has no part ${key} at version ${version ?? project.latestSeenVersion}`);
  return body;
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
