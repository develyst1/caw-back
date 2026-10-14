import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Blueprint } from "../../blueprint/client";
import type { Db } from "../../db/client";
import { accept, listProposals, propose } from "../../proposals/service";
import type { Env } from "../actor";
import { errors } from "../errors";
import { CardSchema } from "./cards";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T, description: string) => ({ ...json(schema, description), required: true as const });

export const ProposalItemSchema = z.object({
  title: z.string().min(1).max(200), todo: z.string().max(8000), anchor: z.object({ key: z.string().min(1), version: z.number().int().min(1) }),
  workerId: z.string().min(1), dependsOn: z.array(z.number().int().min(0)).default([]).openapi({ description: "indexes into the proposal's items" }),
  hops: z.number().int().min(1).max(1000),
});
export const ProposalSchema = z.object({
  id: z.string(), projectId: z.string(), messageId: z.string(), version: z.number().int(), items: z.array(ProposalItemSchema),
  status: z.enum(["open", "accepted", "superseded"]), cardIds: z.array(z.string()).nullable(), createdAt: z.string(),
  hopsTotal: z.number().int().openapi({ description: "the sum of the items' hops, computed on read" }),
}).openapi("Proposal");

export function proposalRoutes(app: OpenAPIHono<Env>, db: Db, blueprint: Blueprint) {
  app.openapi(createRoute({
    method: "post", path: "/v1/projects/{id}/proposals",
    request: { params: z.object({ id: z.string() }), body: body(z.object({ messageId: z.string().min(1), items: z.array(ProposalItemSchema).min(1).max(50) }), "cards the entry worker proposes for the operator's message") },
    responses: { 201: json(ProposalSchema, "the open proposal"), 400: errors[400], 403: errors[403], 404: errors[404], 422: errors[422], 502: errors[502] },
  }), async (c) => c.json(await propose(db, blueprint, c.get("actor"), c.get("hop"), c.req.valid("param").id, c.req.valid("json")), 201));

  app.openapi(createRoute({
    method: "get", path: "/v1/projects/{id}/proposals", request: { params: z.object({ id: z.string() }), query: z.object({ messageId: z.string().optional() }) },
    responses: { 200: json(z.object({ proposals: z.array(ProposalSchema) }), "newest first"), 404: errors[404] },
  }), async (c) => c.json({ proposals: await listProposals(db, c.req.valid("param").id, c.req.valid("query").messageId) }, 200));

  app.openapi(createRoute({
    method: "post", path: "/v1/proposals/{id}/accept", request: { params: z.object({ id: z.string() }) },
    responses: { 200: json(z.object({ cards: z.array(CardSchema) }), "the cards made"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409], 422: errors[422], 502: errors[502] },
  }), async (c) => c.json({ cards: await accept(db, blueprint, c.get("actor"), c.req.valid("param").id) }, 200));
}
