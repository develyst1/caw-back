import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Follower } from "../../follow/pull";
import type { Env } from "../actor";
import { errors } from "../errors";

// Blueprint's push (SPEC-A-005; REQ-105 / SPEC-107 D8), one attempt, no actor. Three kinds, one URL:
//  · version.confirmed { projectId, version ≥ 1, confirmedAt } — as before;
//  · spec.changed { projectId, revision ≥ 0, at } — Blueprint saved an edit;
//  · any other `event` string with a projectId — accepted and ignored (a Blueprint that grows a new notice must not get a 400).
// A body without a string `event` and `projectId`, or a known kind with a bad field, is a 400.
const VersionConfirmed = z.object({ event: z.literal("version.confirmed"), projectId: z.string().min(1), version: z.number().int().min(1), confirmedAt: z.string() });
const SpecChanged = z.object({ event: z.literal("spec.changed"), projectId: z.string().min(1), revision: z.number().int().min(0), at: z.string() });
const OtherEvent = z.object({ event: z.string().refine((e) => e !== "version.confirmed" && e !== "spec.changed", "a known event has its own fields"), projectId: z.string().min(1) });

export function followRoutes(app: OpenAPIHono<Env>, follow: Follower) {
  app.openapi(createRoute({
    method: "post", path: "/v1/notify",
    request: { body: { description: "Blueprint's notice: version.confirmed, spec.changed, or any other event (accepted, ignored)", required: true, content: { "application/json": { schema: z.union([VersionConfirmed, SpecChanged, OtherEvent]) } } } },
    responses: { 202: { description: "accepted — for version.confirmed and spec.changed the pull for that Blueprint project runs now, in the background; any other event does nothing", content: { "application/json": { schema: z.object({}) } } }, 400: errors[400] },
  }), (c) => {
    const notice = c.req.valid("json");
    if (notice.event === "version.confirmed" || notice.event === "spec.changed") void follow.pullFor(notice.projectId); // answered at once; the pull never rejects (follow/pull.ts)
    return c.json({}, 202);
  });
}
