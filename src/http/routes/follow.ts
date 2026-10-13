import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Follower } from "../../follow/pull";
import type { Env } from "../actor";
import { errors } from "../errors";

// Blueprint's push (SPEC-A-005): { event: "version.confirmed", projectId, version, confirmedAt }, one attempt, no actor.
export function followRoutes(app: OpenAPIHono<Env>, follow: Follower) {
  app.openapi(createRoute({
    method: "post", path: "/v1/notify",
    request: { body: { description: "Blueprint's notice", required: true, content: { "application/json": { schema: z.object({
      event: z.literal("version.confirmed"), projectId: z.string().min(1), version: z.number().int().min(1), confirmedAt: z.string(),
    }) } } } },
    responses: { 202: { description: "accepted — the pull for that Blueprint project runs now, in the background", content: { "application/json": { schema: z.object({}) } } }, 400: errors[400] },
  }), (c) => {
    void follow.pullFor(c.req.valid("json").projectId); // answered at once; the pull never rejects (follow/pull.ts)
    return c.json({}, 202);
  });
}
