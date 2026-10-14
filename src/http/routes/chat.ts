import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { defaultWebUrl } from "../../blueprint/client";
import { chatContext, listMessages, postMessage, reply, retryMessage } from "../../chat/service";
import type { Db } from "../../db/client";
import type { Env } from "../actor";
import { errors } from "../errors";
import { ChainSchema } from "./chain";
import { ProjectSchema } from "./projects";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T, description: string) => ({ ...json(schema, description), required: true as const });
const Text = z.string().min(1).max(4000);

export const ChatQuestionSchema = z.object({ text: z.string().min(1).max(2000), proposedDefault: z.string().min(1).max(2000), cases: z.array(z.string().min(1).max(500)).min(1).max(10) });
export const ChatMessageSchema = z.object({
  id: z.string(), projectId: z.string(), author: z.string().openapi({ description: "operator | worker:<id>" }), text: z.string(),
  replyTo: z.string().nullable(), replyHopId: z.string().nullable().openapi({ description: "set on an operator message when a hop answers it" }),
  questions: z.array(ChatQuestionSchema).nullable(), proposalId: z.string().nullable(),
  amendment: z.object({ blueprintMessageId: z.string(), link: z.string() }).nullable(), at: z.string(),
  retryRequestedAt: z.string().nullable().openapi({ description: "set when the operator asked for a retry; cleared when the next hop starts on the message" }),
  chatHop: z.object({ id: z.string(), endedAt: z.string().nullable(), outcome: z.string().nullable() }).nullable().openapi({ description: "the newest chat hop on this message (computed on read)" }),
}).openapi("ChatMessage");

export function chatRoutes(app: OpenAPIHono<Env>, db: Db) {
  app.openapi(createRoute({
    method: "post", path: "/v1/projects/{id}/chat", request: { params: z.object({ id: z.string() }), body: body(z.object({ text: Text }), "the operator's message") },
    responses: { 201: json(ChatMessageSchema, "posted"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => c.json(await postMessage(db, c.get("actor"), c.req.valid("param").id, c.req.valid("json").text), 201));

  app.openapi(createRoute({
    method: "get", path: "/v1/projects/{id}/chat",
    request: { params: z.object({ id: z.string() }), query: z.object({ after: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    responses: { 200: json(z.object({ messages: z.array(ChatMessageSchema) }), "oldest first"), 400: errors[400], 404: errors[404] },
  }), async (c) => c.json({ messages: await listMessages(db, c.req.valid("param").id, c.req.valid("query")) }, 200));

  app.openapi(createRoute({
    method: "get", path: "/v1/chat/{messageId}/context", request: { params: z.object({ messageId: z.string() }) },
    responses: {
      200: json(z.object({ message: ChatMessageSchema, thread: z.array(ChatMessageSchema), project: ProjectSchema, chain: ChainSchema }), "what a worker needs to answer the message"),
      400: errors[400], 403: errors[403], 404: errors[404],
    },
  }), async (c) => c.json(await chatContext(db, c.get("actor"), c.get("hop"), c.req.valid("param").messageId), 200));

  app.openapi(createRoute({
    method: "post", path: "/v1/chat/{messageId}/reply",
    request: { params: z.object({ messageId: z.string() }), body: body(z.object({
      text: Text, questions: z.array(ChatQuestionSchema).max(10).optional(), proposalId: z.string().min(1).optional(),
      amendment: z.object({ blueprintMessageId: z.string().min(1).max(200) }).optional(),
    }), "the entry worker's reply") },
    responses: { 201: json(ChatMessageSchema, "the reply"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => c.json(await reply(db, c.get("actor"), c.get("hop"), c.req.valid("param").messageId, c.req.valid("json"), defaultWebUrl()), 201));

  app.openapi(createRoute({
    method: "post", path: "/v1/chat/{messageId}/retry", request: { params: z.object({ messageId: z.string() }) },
    responses: { 202: json(z.object({}), "retry requested — the runner treats the message like a new one"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => {
    await retryMessage(db, c.get("actor"), c.req.valid("param").messageId);
    return c.json({}, 202);
  });
}
