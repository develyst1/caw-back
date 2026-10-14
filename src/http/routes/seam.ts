import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Blueprint } from "../../blueprint/client";
import type { Db } from "../../db/client";
import { amend, locate } from "../../seam/service";
import type { Env } from "../actor";
import { errors } from "../errors";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T, description: string) => ({ ...json(schema, description), required: true as const });
const Id = z.object({ id: z.string() });
const Opaque = z.unknown().openapi({ description: "Blueprint's answer, exactly as returned" });

export function seamRoutes(app: OpenAPIHono<Env>, db: Db, blueprint: Blueprint) {
  app.openapi(createRoute({
    method: "post", path: "/v1/projects/{id}/locate", request: { params: Id, body: body(z.object({ request: z.string().min(1).max(1000) }), "what to find in the confirmed spec") },
    responses: { 200: json(Opaque, "Blueprint's Located"), 400: errors[400], 403: errors[403], 404: errors[404], 502: errors[502] },
  }), async (c) => c.json(await locate(db, blueprint, c.get("actor"), c.get("hop"), c.req.valid("param").id, c.req.valid("json").request) as never, 200));

  app.openapi(createRoute({
    method: "post", path: "/v1/projects/{id}/amendments",
    request: { params: Id, body: body(z.object({ request: z.string().min(1).max(4000), about: z.array(z.string().min(1)).max(20).optional() }), "a request to change the spec, sent to Blueprint's chat") },
    responses: { 201: json(Opaque, "Blueprint's Message"), 400: errors[400], 403: errors[403], 404: errors[404], 502: errors[502] },
  }), async (c) => c.json(await amend(db, blueprint, c.get("actor"), c.get("hop"), c.req.valid("param").id, c.req.valid("json")) as never, 201));
}
