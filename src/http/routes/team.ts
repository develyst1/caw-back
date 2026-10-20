// Team status (SPEC-A-009 § R1b + Revision 1, contract v1.16): is the runner alive? The runner checks in (POST /v1/runner/check-in { state }) and the
// screen asks (GET /v1/team-status). The core keeps { name, lastSeenAt, state } of the last check-in IN MEMORY: this is process liveness, not project
// history, so it writes no event and no table — the one exception to "every write is an event", stated in the SPEC so nobody copies it. After an API
// restart it is empty until the next check-in (the runner checks in at least every 15 s, and once with `stopping` on a clean stop).
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Env } from "../actor";
import { ApiError, errors } from "../errors";

/** `running` = the last check-in said `running` and is at most 45 s old (3 missed 15-s check-ins); a `stopping` one makes it false at once */
export const RUNNING_WITHIN_MS = 45_000;
// The "team not running" screen exists only while the API answers, so only the runner is missing: that is what the screen tells the operator to run
// (D-103 DEF-1). `bun run dev` stays the one command for a cold start (CORE.md).
export const START_COMMAND = "cd caw-back && bun run runner";
export type CheckInState = "running" | "stopping";

export type TeamStatus = { running: boolean; runnerName: string | null; lastSeenAt: string | null; startCommand: typeof START_COMMAND };

/** one per app (tests inject the clock); nothing is module-global */
export function createTeamStatus(clock: () => Date = () => new Date()) {
  let last: { name: string; at: Date; state: CheckInState } | null = null;
  return {
    checkIn(name: string, state: CheckInState): void { last = { name, at: clock(), state }; },
    status(): TeamStatus {
      return {
        running: last !== null && last.state === "running" && clock().getTime() - last.at.getTime() <= RUNNING_WITHIN_MS,
        runnerName: last?.name ?? null,
        lastSeenAt: last?.at.toISOString() ?? null,
        startCommand: START_COMMAND,
      };
    },
  };
}
export type TeamStatusHolder = ReturnType<typeof createTeamStatus>;

const StatusSchema = z.object({
  running: z.boolean().openapi({ description: "the last check-in said `running` and is at most 45 s old (a `stopping` check-in makes it false at once)" }),
  runnerName: z.string().nullable(), lastSeenAt: z.string().nullable().openapi({ description: "the last check-in, kept after the team goes quiet" }),
  startCommand: z.literal(START_COMMAND).openapi({ description: "what the screen tells the operator to run when running is false" }),
}).openapi("TeamStatus");

export function teamRoutes(app: OpenAPIHono<Env>, team: TeamStatusHolder) {
  app.openapi(createRoute({
    method: "post", path: "/v1/runner/check-in",
    request: { body: { required: true, content: { "application/json": { schema: z.object({ state: z.enum(["running", "stopping"]) }) } }, description: "`running` while it works, `stopping` once on a clean stop" } },
    responses: { 204: { description: "noted — the name is the runner's actor, the time is the core's clock; only `state` is read from the body" }, 400: errors[400], 403: errors[403] },
  }), (c) => {
    const actor = c.get("actor");
    if (!actor.startsWith("runner:")) throw new ApiError(403, "runner_only", "only the runner checks in");
    team.checkIn(actor.slice("runner:".length), c.req.valid("json").state);
    return c.body(null, 204);
  });

  app.openapi(createRoute({
    method: "get", path: "/v1/team-status",
    responses: { 200: { description: "is the runner alive?", content: { "application/json": { schema: StatusSchema } } } },
  }), (c) => c.json(team.status(), 200));
}
