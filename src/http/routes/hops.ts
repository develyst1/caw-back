import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Blueprint } from "../../blueprint/client";
import { pinHop } from "../../blueprint/latest";
import { loadState } from "../../core/state";
import type { Db } from "../../db/client";
import { finishRun, heartbeatHop, listHops, listRuns, patchHop, startHop, startRun } from "../../hops/service";
import type { Env } from "../actor";
import { errors } from "../errors";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T, description: string) => ({ ...json(schema, description), required: true as const });
const ProjectId = z.object({ id: z.string() });
const Outcome = z.enum(["commented", "handed_off", "status", "asked", "failed", "stopped", "interrupted", "replied", "proposed", "amended", "proposed_and_amended"]);
const StopReason = z.enum(["budget_spent", "nothing_workable", "failed_review_twice", "limit_reached", "operator_stopped", "error", "no_progress"]);

const HopSchema = z.object({
  id: z.string(), projectId: z.string(), runId: z.string().nullable(), claimedBy: z.string().nullable(), cardId: z.string().nullable(), messageId: z.string().nullable(),
  locatedKeys: z.array(z.string()).nullable().openapi({ description: "a chat hop: the keys of every locate it made (v1.6); never the spec text" }), workerId: z.string(),
  startedAt: z.string(), lastActivityAt: z.string().openapi({ description: "startedAt, then the last heartbeat (v1.11); the screen shows how long a running hop has been silent from it" }), endedAt: z.string().nullable(), outcome: Outcome.nullable(), tokensIn: z.number().int().nullable(), tokensOut: z.number().int().nullable(), note: z.string(),
}).openapi("Hop");
const RunSchema = z.object({
  id: z.string(), projectId: z.string(), mode: z.enum(["manual", "dispatcher"]), hopBudget: z.number().int(), startedAt: z.string(), endedAt: z.string().nullable(),
  stopReason: StopReason.nullable(), report: z.string().nullable(), hopsUsed: z.number().int().openapi({ description: "its finished hops, computed on read" }),
}).openapi("Run");

// finish a hop, or claim it — one or the other
const Finish = z.strictObject({
  outcome: Outcome, tokensIn: z.number().int().min(0).optional(), tokensOut: z.number().int().min(0).optional(), note: z.string().max(2000).optional(),
});
const Claim = z.strictObject({ claim: z.string().min(1).max(200) });

export function hopRoutes(app: OpenAPIHono<Env>, db: Db, blueprint: Blueprint) {
  app.openapi(createRoute({
    method: "post", path: "/v1/projects/{id}/hops",
    request: { params: ProjectId, body: body(z.object({
      cardId: z.string().min(1).optional(), messageId: z.string().min(1).optional(), workerId: z.string().min(1), runId: z.string().min(1).optional(), claim: z.string().min(1).max(200).optional(),
    }).refine((b) => (b.cardId === undefined) !== (b.messageId === undefined), "give exactly one of cardId and messageId"), "start a hop: one turn of one worker on one workable card — or, as the entry worker, on one unanswered chat message") },
    responses: { 201: json(HopSchema, "the running hop"), 400: errors[400], 404: errors[404], 409: errors[409] },
  }), async (c) => {
    const projectId = c.req.valid("param").id;
    const hop = await startHop(db, c.get("actor"), projectId, c.req.valid("json"));
    // REQ-105 (SPEC-107 D5): a CARD hop keeps the text it started with — read the card's part now and pin it. It never fails the hop (a failed pin is one log line; card_context then falls back
    // to the latest read). A chat hop is not pinned: it locates on demand.
    if (hop.cardId !== null) {
      const s = await loadState(db, projectId);
      const card = s.cards.find((x) => x.id === hop.cardId);
      if (s.project && card) await pinHop(db, blueprint, s.project, hop.id, card.anchorKey);
    }
    return c.json(hop, 201);
  });

  app.openapi(createRoute({
    method: "patch", path: "/v1/hops/{hopId}", request: { params: z.object({ hopId: z.string() }), body: body(z.union([Finish, Claim]), "finish the hop, or claim it (set once)") },
    responses: { 200: json(HopSchema, "the hop"), 400: errors[400], 404: errors[404], 409: errors[409] },
  }), async (c) => c.json(await patchHop(db, c.get("actor"), c.req.valid("param").hopId, c.req.valid("json")), 200));

  app.openapi(createRoute({
    method: "post", path: "/v1/hops/{hopId}/heartbeat", request: { params: z.object({ hopId: z.string() }) },
    responses: { 200: json(z.object({ lastActivityAt: z.string() }), "the hop's lastActivityAt — the core's own time; unchanged when the last write was under 60 s ago"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => c.json(await heartbeatHop(db, c.get("actor"), c.req.valid("param").hopId), 200));

  app.openapi(createRoute({
    method: "get", path: "/v1/projects/{id}/hops",
    request: { params: ProjectId, query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), runId: z.string().optional() }) },
    responses: { 200: json(z.object({ hops: z.array(HopSchema) }), "newest first"), 400: errors[400], 404: errors[404] },
  }), async (c) => c.json({ hops: await listHops(db, c.req.valid("param").id, c.req.valid("query")) }, 200));

  app.openapi(createRoute({
    method: "post", path: "/v1/projects/{id}/runs",
    request: { params: ProjectId, body: body(z.object({ hopBudget: z.number().int().min(0) }), "open a run with its own hop budget") },
    responses: { 201: json(RunSchema, "the open run"), 400: errors[400], 404: errors[404], 409: errors[409] },
  }), async (c) => c.json(await startRun(db, c.get("actor"), c.req.valid("param").id, c.req.valid("json").hopBudget), 201));

  app.openapi(createRoute({
    method: "patch", path: "/v1/runs/{runId}",
    request: { params: z.object({ runId: z.string() }), body: body(z.object({ stopReason: StopReason, report: z.string().max(20000) }), "finish the run") },
    responses: { 200: json(RunSchema, "the finished run"), 400: errors[400], 404: errors[404], 409: errors[409] },
  }), async (c) => c.json(await finishRun(db, c.get("actor"), c.req.valid("param").runId, c.req.valid("json")), 200));

  app.openapi(createRoute({
    method: "get", path: "/v1/projects/{id}/runs",
    request: { params: ProjectId, query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) },
    responses: { 200: json(z.object({ runs: z.array(RunSchema) }), "newest first"), 400: errors[400], 404: errors[404] },
  }), async (c) => c.json({ runs: await listRuns(db, c.req.valid("param").id, c.req.valid("query").limit) }, 200));
}
