import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { addEdge, addMember, getChain, removeEdge, removeMember, setEntry } from "../../chain/service";
import type { Db } from "../../db/client";
import type { Env } from "../actor";
import { errors } from "../errors";
import { WorkerSchema } from "./workers";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const Id = z.object({ id: z.string() });
const Edge = z.object({ from: z.string().min(1), to: z.string().min(1) });
const WorkerRef = z.object({ workerId: z.string().min(1) });

const ChainSchema = z.object({
  members: z.array(WorkerSchema), edges: z.array(Edge), entryWorkerId: z.string().nullable(),
}).openapi("Chain");
const chain = (description: string) => json(ChainSchema, description);
const body = <T extends z.ZodType>(schema: T, description: string) => ({ ...json(schema, description), required: true as const });

export function chainRoutes(app: OpenAPIHono<Env>, db: Db) {
  app.openapi(createRoute({
    method: "get", path: "/v1/projects/{id}/chain", request: { params: Id },
    responses: { 200: chain("the project's chain"), 404: errors[404] },
  }), async (c) => c.json(await getChain(db, c.req.valid("param").id), 200));

  app.openapi(createRoute({
    method: "post", path: "/v1/projects/{id}/chain/members", request: { params: Id, body: body(WorkerRef, "a worker to put in the chain") },
    responses: { 200: chain("the chain now"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => c.json(await addMember(db, c.get("actor"), c.req.valid("param").id, c.req.valid("json").workerId), 200));

  app.openapi(createRoute({
    method: "delete", path: "/v1/projects/{id}/chain/members/{workerId}",
    request: { params: Id.extend({ workerId: z.string() }), query: z.object({ reassignTo: z.string().optional() }) },
    responses: { 200: chain("the chain now"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => {
    const { id, workerId } = c.req.valid("param");
    return c.json(await removeMember(db, c.get("actor"), id, workerId, c.req.valid("query").reassignTo || null), 200);
  });

  app.openapi(createRoute({
    method: "post", path: "/v1/projects/{id}/chain/edges", request: { params: Id, body: body(Edge, "who may hand a card to whom") },
    responses: { 200: chain("the chain now"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => {
    const { from, to } = c.req.valid("json");
    return c.json(await addEdge(db, c.get("actor"), c.req.valid("param").id, from, to), 200);
  });

  app.openapi(createRoute({
    method: "delete", path: "/v1/projects/{id}/chain/edges", request: { params: Id, body: body(Edge, "the edge to remove") },
    responses: { 200: chain("the chain now"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => {
    const { from, to } = c.req.valid("json");
    return c.json(await removeEdge(db, c.get("actor"), c.req.valid("param").id, from, to), 200);
  });

  app.openapi(createRoute({
    method: "put", path: "/v1/projects/{id}/chain/entry", request: { params: Id, body: body(WorkerRef, "the worker who takes the first card") },
    responses: { 200: chain("the chain now"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => c.json(await setEntry(db, c.get("actor"), c.req.valid("param").id, c.req.valid("json").workerId), 200));
}
