import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { combineWorkers, createWorker, deleteWorker, listWorkers, updateWorker } from "../../workers/service";
import type { Env } from "../actor";
import { errors } from "../errors";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });

const RoleSchema = z.enum(["PM", "BA", "SA", "FE", "BE", "QA", "other"]);
const RolesSchema = z.array(RoleSchema).min(1).max(7).refine((r) => new Set(r).size === r.length, "roles: no repeats").openapi({ description: "one or more roles, in the order picked" });
const Name = z.string().trim().min(1).max(40);
// v1.12: three short ids, all required, nothing else. The SHAPE is checked here; the ids are never checked against a list (that list is the screen's).
const AvatarId = z.string().regex(/^[a-z0-9-]{1,24}$/, "an id is 1–24 characters of a-z, 0-9 and -");
const AvatarSchema = z.strictObject({ body: AvatarId, color: AvatarId, eyes: AvatarId }).openapi("Avatar", { description: "a worker's chosen face; null on the worker = not chosen (the screen derives one from the name)" });
const Skills = z.array(z.string().trim().min(1)).min(1).max(50);

export const WorkerSchema = z.object({
  id: z.string(), name: z.string(), roles: z.array(RoleSchema).min(1), role: RoleSchema.openapi({ description: "roles[0] — deprecated, read `roles`" }), skills: z.array(z.string()),
  model: z.enum(["opus", "sonnet", "haiku"]), effort: z.enum(["low", "medium", "high"]), avatar: AvatarSchema.nullable(), combinedFrom: z.array(z.string()).nullable(),
  deletedAt: z.string().nullable().openapi({ description: "set when the operator deleted the worker (v1.14); the list still shows them so history can name them — screens hide them from every picker" }),
}).openapi("Worker");

export function workerRoutes(app: OpenAPIHono<Env>, db: Db) {
  app.openapi(createRoute({
    method: "post", path: "/v1/workers",
    request: { body: { ...json(z.object({
      name: Name,
      roles: RolesSchema.optional(),
      role: RoleSchema.optional().openapi({ description: "deprecated — the old single role, read as roles: [role]; send exactly one of `roles` / `role`" }),
      skills: Skills,
      model: z.enum(["opus", "sonnet", "haiku"]).optional(),
      effort: z.enum(["low", "medium", "high"]).optional(),
      avatar: AvatarSchema.nullable().optional(),
    }).refine((b) => (b.roles === undefined) !== (b.role === undefined), "send exactly one of roles / role"), "a worker; model / effort default to the strongest of the roles' defaults"), required: true } },
    responses: { 201: json(WorkerSchema, "created"), 400: errors[400], 403: errors[403], 409: errors[409] },
  }), async (c) => {
    const { role, roles, ...rest } = c.req.valid("json");
    return c.json(await createWorker(db, c.get("actor"), { ...rest, roles: roles ?? [role!] }), 201);
  });

  app.openapi(createRoute({
    method: "patch", path: "/v1/workers/{id}", request: { params: z.object({ id: z.string() }), body: { ...json(z.object({
      name: Name.optional(), roles: RolesSchema.optional(), skills: Skills.optional(),
      model: z.enum(["opus", "sonnet", "haiku"]).optional(), effort: z.enum(["low", "medium", "high"]).optional(),
      avatar: AvatarSchema.nullable().optional(),
    }).refine((b) => Object.values(b).some((v) => v !== undefined), "send at least one of name / roles / skills / model / effort / avatar"), "the fields to change — only what is sent changes"), required: true } },
    responses: { 200: json(WorkerSchema, "the worker after the change"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => c.json(await updateWorker(db, c.get("actor"), c.req.valid("param").id, c.req.valid("json")), 200));

  app.openapi(createRoute({
    method: "delete", path: "/v1/workers/{id}", request: { params: z.object({ id: z.string() }) },
    responses: { 204: { description: "deleted — kept with deletedAt set" }, 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => {
    await deleteWorker(db, c.get("actor"), c.req.valid("param").id);
    return c.body(null, 204);
  });

  app.openapi(createRoute({
    method: "post", path: "/v1/workers/combine", deprecated: true,
    request: { body: { ...json(z.object({
      name: z.string().trim().min(1).max(40),
      workerIds: z.tuple([z.string().min(1), z.string().min(1)]),
    }).refine((b) => b.workerIds[0] !== b.workerIds[1], "workerIds: two different workers"), "two workers to combine into a new one"), required: true } },
    responses: { 201: json(WorkerSchema, "created"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => c.json(await combineWorkers(db, c.get("actor"), c.req.valid("json") as { name: string; workerIds: [string, string] }), 201));

  app.openapi(createRoute({
    method: "get", path: "/v1/workers",
    responses: { 200: json(z.object({ workers: z.array(WorkerSchema) }), "every worker") },
  }), async (c) => c.json({ workers: await listWorkers(db) }, 200));
}
