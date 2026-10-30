import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Blueprint } from "../../blueprint/client";
import type { Db } from "../../db/client";
import { checkRebuild, confirmCodeMap, createProject, getProject, listEvents, listProjects, projectView, readPart, saveCodeMap, setMode, setWorkspace } from "../../projects/service";
import { type Env, requireOperator } from "../actor";
import { errors } from "../errors";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const Id = z.object({ id: z.string() }); // not .uuid(): an id that is no project is 404, as Blueprint does

// v1.16 (REQ-015 R2a): the setup step's result. Every string 1–500, notes ≤ 2 000, each list ≤ 50, folders ≥ 1; rules (and the other lists) may be empty.
const Str = z.string().min(1).max(500);
export const CodeMapInputSchema = z.object({
  folders: z.array(z.object({ name: Str, kind: z.enum(["fe", "be", "other"]), note: Str.optional() })).min(1).max(50),
  stack: z.array(Str).max(50), commands: z.object({ run: z.array(Str).max(50), test: z.array(Str).max(50) }),
  rules: z.array(Str).max(50).openapi({ description: "may be empty — the screen shows ไม่มี" }),
  questions: z.array(z.object({ text: Str, proposedDefault: Str })).max(50), notes: z.string().min(1).max(2000).optional(),
}).openapi("CodeMapInput");
export const CodeMapSchema = CodeMapInputSchema.extend({
  updatedAt: z.string(), updatedBy: z.string().openapi({ description: "the worker who saved it" }), confirmedAt: z.string().nullable().openapi({ description: "set by the operator's confirm; cleared by every new save" }),
}).openapi("CodeMap");

export const ProjectSchema = z.object({
  id: z.string(), name: z.string(), blueprintProjectId: z.string(),
  version: z.number().int().openapi({ description: "from REQ-105 on: the LABEL number when the project started (0 = no label then)" }),
  latestSeenVersion: z.number().int().openapi({ description: "the latest label number seen (0 = none)" }),
  latestLabel: z.object({ version: z.number().int(), label: z.string() }).nullable().openapi({ description: "the latest label Blueprint showed: its number and words; null = none (REQ-105)" }),
  mode: z.enum(["manual", "dispatcher"]), hopBudget: z.number().int(), hopsUsed: z.number().int(),
  entryWorkerId: z.string().nullable(), workspace: z.object({ roots: z.array(z.string()), readOnly: z.array(z.string()).openapi({ description: "⊆ roots; workers read every root and write only the others (D-100)" }) }),
  codeMap: z.union([CodeMapSchema, z.null()]).openapi({ description: "null until the entry worker saves one (v1.16)" }), createdAt: z.string(),
  spec: z.object({
    revision: z.number().int().openapi({ description: "the spec revision the follower has pulled to (0 = nothing pulled yet)" }),
    reachable: z.boolean().openapi({ description: "false when the last pull could not reach Blueprint; it catches up on its own when Blueprint is back" }),
    lastPullAt: z.string().nullable().openapi({ description: "when a pull last got through; null = never" }),
  }).openapi({ description: "REQ-105: how up to date CAW's view of the spec is" }),
}).openapi("Project");
const ProjectSummarySchema = ProjectSchema.extend({
  cardsDone: z.number().int(), cardsTotal: z.number().int(), stuckCount: z.number().int(),
}).openapi("ProjectSummary");
const EventSchema = z.object({
  seq: z.number().int(), projectId: z.string().nullable(), type: z.string(), actor: z.string(), at: z.string(), data: z.unknown(),
}).openapi("Event");

export function projectRoutes(app: OpenAPIHono<Env>, db: Db, blueprint: Blueprint) {
  app.openapi(createRoute({
    method: "post", path: "/v1/projects",
    // REQ-105 (D11): a project starts from Blueprint's CURRENT spec. `version` is optional and IGNORED (old links); no confirmed version or label is needed — 409 version_not_confirmed is gone.
    request: { body: { ...json(z.object({ blueprintProjectId: z.string().min(1), version: z.number().int().min(0).optional() }), "a Blueprint project — one CAW project per Blueprint project: 409 already_exists { id } when one exists (the project follows the spec itself)"), required: true } },
    responses: { 201: json(ProjectSchema, "created"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409], 502: errors[502] },
  }), async (c) => {
    requireOperator(c.get("actor"));
    return c.json(await projectView(db, await createProject(db, blueprint, c.get("actor"), c.req.valid("json"))), 201);
  });

  app.openapi(createRoute({
    method: "get", path: "/v1/projects",
    responses: { 200: json(z.object({ projects: z.array(ProjectSummarySchema) }), "every project, newest first") },
  }), async (c) => c.json({ projects: await listProjects(db) }, 200));

  app.openapi(createRoute({
    method: "get", path: "/v1/projects/{id}", request: { params: Id },
    responses: { 200: json(ProjectSchema, "the project"), 404: errors[404] },
  }), async (c) => c.json(await projectView(db, await getProject(db, c.req.valid("param").id)), 200));

  app.openapi(createRoute({
    method: "patch", path: "/v1/projects/{id}/mode",
    request: { params: Id, body: { ...json(z.object({ mode: z.enum(["manual", "dispatcher"]), hopBudget: z.number().int().min(0).optional() }), "the mode, and optionally the hop budget"), required: true } },
    responses: { 200: json(ProjectSchema, "the project; hopsUsed, cards and hops are untouched"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => c.json(await projectView(db, await setMode(db, c.get("actor"), c.req.valid("param").id, c.req.valid("json"))), 200));

  // an absolute path (POSIX or Windows drive), no `..` segment, ≤ 500 chars
  const Root = z.string().min(1).max(500)
    .refine((p) => /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p), "a workspace root is an absolute path")
    .refine((p) => !p.split(/[\\/]/).includes(".."), "a workspace root has no `..` segment");
  app.openapi(createRoute({
    method: "patch", path: "/v1/projects/{id}/workspace",
    request: { params: Id, body: { ...json(z.object({ roots: z.array(Root).max(20), readOnly: z.array(z.string()).max(20).optional() })
      .refine((b) => (b.readOnly ?? []).every((r) => b.roots.includes(r)), "readOnly: every entry must be one of roots")
      .refine((b) => new Set(b.readOnly ?? []).size === (b.readOnly ?? []).length, "readOnly: no repeats"), "the folders a worker may work in (replaces the list); readOnly ⊆ roots, default [] = all writable"), required: true } },
    responses: { 200: json(ProjectSchema, "the project"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => c.json(await projectView(db, await setWorkspace(db, c.get("actor"), c.req.valid("param").id, c.req.valid("json"))), 200));

  app.openapi(createRoute({
    method: "put", path: "/v1/projects/{id}/code-map",
    request: { params: Id, body: { ...json(CodeMapInputSchema, "the setup step's result — written by the entry worker from its running chat hop"), required: true } },
    responses: { 200: json(CodeMapSchema, "the code map (confirmedAt null)"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => c.json(await saveCodeMap(db, c.get("actor"), c.get("hop"), c.req.valid("param").id, c.req.valid("json")), 200));

  app.openapi(createRoute({
    method: "post", path: "/v1/projects/{id}/code-map/confirm", request: { params: Id },
    responses: { 200: json(CodeMapSchema, "the code map with confirmedAt"), 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => c.json(await confirmCodeMap(db, c.get("actor"), c.req.valid("param").id), 200));

  app.openapi(createRoute({
    method: "get", path: "/v1/projects/{id}/parts/{key}",
    // REQ-105: `version` is still accepted (old callers) and IGNORED — the part is always read from the current spec (a revision, not a version, is what Blueprint has)
    request: { params: z.object({ id: z.string(), key: z.string() }), query: z.object({ version: z.coerce.number().int().min(0).optional() }) },
    responses: {
      200: json(z.unknown().openapi({ description: "Blueprint's v2 part context, exactly as returned (the last body read when Blueprint is down)" }), "the part in the current spec"),
      400: errors[400], 404: errors[404], 502: errors[502],
    },
  }), async (c) => c.json(await readPart(db, blueprint, c.req.valid("param").id, c.req.valid("param").key) as never, 200));

  app.openapi(createRoute({
    method: "get", path: "/v1/projects/{id}/events",
    request: { params: Id, query: z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }) },
    responses: { 200: json(z.object({ events: z.array(EventSchema) }), "the project's events, oldest first"), 400: errors[400], 404: errors[404] },
  }), async (c) => {
    const { after, limit } = c.req.valid("query");
    return c.json({ events: await listEvents(db, c.req.valid("param").id, after, limit) }, 200);
  });

  app.openapi(createRoute({
    method: "post", path: "/v1/projects/{id}/rebuild-check", request: { params: Id },
    responses: {
      200: json(z.object({ same: z.boolean(), diff: z.record(z.string(), z.unknown()).optional() }), "a rebuild from the events, compared with the tables; writes nothing"),
      404: errors[404],
    },
  }), async (c) => c.json(await checkRebuild(db, c.req.valid("param").id), 200));
}
