import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Blueprint } from "../../blueprint/client";
import type { Db } from "../../db/client";
import { checkRebuild, createProject, getProject, listEvents, listProjects, readPart, setMode, setWorkspace } from "../../projects/service";
import { type Env, requireOperator } from "../actor";
import { errors } from "../errors";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const Id = z.object({ id: z.string() }); // not .uuid(): an id that is no project is 404, as Blueprint does

export const ProjectSchema = z.object({
  id: z.string(), name: z.string(), blueprintProjectId: z.string(), version: z.number().int(), latestSeenVersion: z.number().int(),
  mode: z.enum(["manual", "dispatcher"]), hopBudget: z.number().int(), hopsUsed: z.number().int(),
  entryWorkerId: z.string().nullable(), workspace: z.object({ roots: z.array(z.string()) }), createdAt: z.string(),
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
    request: { body: { ...json(z.object({ blueprintProjectId: z.string().min(1), version: z.number().int().min(1) }), "a confirmed Blueprint version — one CAW project per Blueprint project: 409 already_exists { id } when one exists, at any version (the project follows newer versions itself)"), required: true } },
    responses: { 201: json(ProjectSchema, "created"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409], 502: errors[502] },
  }), async (c) => {
    requireOperator(c.get("actor"));
    return c.json(await createProject(db, blueprint, c.get("actor"), c.req.valid("json")), 201);
  });

  app.openapi(createRoute({
    method: "get", path: "/v1/projects",
    responses: { 200: json(z.object({ projects: z.array(ProjectSummarySchema) }), "every project, newest first") },
  }), async (c) => c.json({ projects: await listProjects(db) }, 200));

  app.openapi(createRoute({
    method: "get", path: "/v1/projects/{id}", request: { params: Id },
    responses: { 200: json(ProjectSchema, "the project"), 404: errors[404] },
  }), async (c) => c.json(await getProject(db, c.req.valid("param").id), 200));

  app.openapi(createRoute({
    method: "patch", path: "/v1/projects/{id}/mode",
    request: { params: Id, body: { ...json(z.object({ mode: z.enum(["manual", "dispatcher"]), hopBudget: z.number().int().min(0).optional() }), "the mode, and optionally the hop budget"), required: true } },
    responses: { 200: json(ProjectSchema, "the project; hopsUsed, cards and hops are untouched"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => c.json(await setMode(db, c.get("actor"), c.req.valid("param").id, c.req.valid("json")), 200));

  // an absolute path (POSIX or Windows drive), no `..` segment, ≤ 500 chars
  const Root = z.string().min(1).max(500)
    .refine((p) => /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p), "a workspace root is an absolute path")
    .refine((p) => !p.split(/[\\/]/).includes(".."), "a workspace root has no `..` segment");
  app.openapi(createRoute({
    method: "patch", path: "/v1/projects/{id}/workspace",
    request: { params: Id, body: { ...json(z.object({ roots: z.array(Root).max(20) }), "the folders a worker may work in (replaces the list)"), required: true } },
    responses: { 200: json(ProjectSchema, "the project"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => c.json(await setWorkspace(db, c.get("actor"), c.req.valid("param").id, c.req.valid("json").roots), 200));

  app.openapi(createRoute({
    method: "get", path: "/v1/projects/{id}/parts/{key}",
    request: { params: z.object({ id: z.string(), key: z.string() }), query: z.object({ version: z.coerce.number().int().min(1).optional() }) },
    responses: {
      200: json(z.unknown().openapi({ description: "Blueprint's PartContext, exactly as returned — never stored" }), "the part at that version"),
      400: errors[400], 404: errors[404], 502: errors[502],
    },
  }), async (c) => c.json(await readPart(db, blueprint, c.req.valid("param").id, c.req.valid("param").key, c.req.valid("query").version) as never, 200));

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
