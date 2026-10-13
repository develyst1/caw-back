import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "../../db/client";
import { combineWorkers, createWorker, listWorkers } from "../../workers/service";
import type { Env } from "../actor";
import { errors } from "../errors";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });

export const WorkerSchema = z.object({
  id: z.string(), name: z.string(), role: z.enum(["PM", "SA", "FE", "BE", "QA", "other"]), skills: z.array(z.string()),
  model: z.enum(["opus", "sonnet", "haiku"]), effort: z.enum(["low", "medium", "high"]), combinedFrom: z.array(z.string()).nullable(),
}).openapi("Worker");

export function workerRoutes(app: OpenAPIHono<Env>, db: Db) {
  app.openapi(createRoute({
    method: "post", path: "/v1/workers",
    request: { body: { ...json(z.object({
      name: z.string().trim().min(1).max(40),
      role: z.enum(["PM", "SA", "FE", "BE", "QA", "other"]),
      skills: z.array(z.string().trim().min(1)).min(1).max(50),
      model: z.enum(["opus", "sonnet", "haiku"]).optional(),
      effort: z.enum(["low", "medium", "high"]).optional(),
    }), "a worker; model / effort default by role"), required: true } },
    responses: { 201: json(WorkerSchema, "created"), 400: errors[400], 403: errors[403], 409: errors[409] },
  }), async (c) => c.json(await createWorker(db, c.get("actor"), c.req.valid("json")), 201));

  app.openapi(createRoute({
    method: "post", path: "/v1/workers/combine",
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
