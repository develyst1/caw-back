import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Blueprint } from "../../blueprint/client";
import { addComment, answerQuestion, askQuestion, assign, cardContext, clearSpecChange, createCard, getCard, handOff, listCards, setStatus } from "../../cards/service";
import type { Db } from "../../db/client";
import type { Env } from "../actor";
import { errors } from "../errors";
import { CodeMapSchema } from "./projects";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T, description: string) => ({ ...json(schema, description), required: true as const });
const ProjectId = z.object({ id: z.string() });
const CardId = z.object({ cardId: z.string() });
const Status = z.enum(["todo", "doing", "review", "done", "stuck"]);
const Text = z.string().min(1).max(8000);

export const CardSchema = z.object({
  id: z.string(), projectId: z.string(), number: z.number().int(), kind: z.enum(["work", "question"]), title: z.string(), todo: z.string(),
  status: Status, assigneeId: z.string().nullable(), anchor: z.object({ key: z.string(), version: z.number().int() }),
  specChangedVersion: z.number().int().nullable(), dependsOn: z.array(z.string()),
  question: z.object({ text: z.string(), proposedDefault: z.string(), cases: z.array(z.string()) }).nullable(), answer: z.string().nullable(),
  workable: z.boolean(),
  stoppedMidway: z.object({ hopId: z.string(), at: z.string(), reason: z.string() }).nullable().openapi({ description: "a card back in `todo` after a hop that failed, was stopped or was interrupted: that hop, when it ended, and the leading sentence of its note; null otherwise (SPEC-108 D7)" }),
  createdAt: z.string(), updatedAt: z.string(),
}).openapi("Card");
const NoteSchema = z.object({
  id: z.string(), type: z.enum(["comment", "handoff", "handoff_refused"]), actor: z.string(), text: z.string(),
  fromWorkerId: z.string().nullable(), toWorkerId: z.string().nullable(),
  allowed: z.array(z.string()).nullable().openapi({ description: "handoff_refused only: who the sender could have handed the card to" }), at: z.string(),
}).openapi("Note");
const CardContextSchema = z.object({
  card: CardSchema, spec: z.unknown().openapi({ description: "Blueprint's PartContext, exactly as its seam returned it" }), notes: z.array(NoteSchema),
  decisions: z.array(z.object({ cardId: z.string(), number: z.number().int(), question: z.string(), answer: z.string() })),
  codeMap: z.union([CodeMapSchema, z.null()]).openapi({ description: "the project's code map (v1.16) — null until the entry worker saves one; every card hop knows the folders" }),
}).openapi("CardContext");

const card = (description: string) => json(CardSchema, description);

export function cardRoutes(app: OpenAPIHono<Env>, db: Db, blueprint: Blueprint) {
  app.openapi(createRoute({
    method: "post", path: "/v1/projects/{id}/cards",
    request: { params: ProjectId, body: body(z.object({
      title: z.string().min(1).max(200), todo: z.string().max(8000),
      // optional in the schema so that a missing anchor answers with its own code (anchor_required), not a generic 400
      anchor: z.object({ key: z.string().min(1), version: z.number().int().min(1) }).optional(),
      assigneeId: z.string().optional(), dependsOn: z.array(z.string()).optional(),
    }), "a card, anchored to a part of a confirmed Blueprint version") },
    responses: { 201: card("created"), 400: errors[400], 403: errors[403], 404: errors[404], 422: errors[422], 502: errors[502] },
  }), async (c) => c.json(await createCard(db, blueprint, c.get("actor"), c.req.valid("param").id, c.req.valid("json")), 201));

  app.openapi(createRoute({
    method: "get", path: "/v1/projects/{id}/cards",
    request: { params: ProjectId, query: z.object({
      assigneeId: z.string().optional(), status: Status.optional(),
      workable: z.enum(["true", "false"]).optional().openapi({ description: "`true` keeps only the workable cards" }),
    }) },
    responses: { 200: json(z.object({ cards: z.array(CardSchema) }), "the project's cards by number"), 400: errors[400], 404: errors[404] },
  }), async (c) => {
    const q = c.req.valid("query");
    return c.json({ cards: await listCards(db, c.req.valid("param").id, { assigneeId: q.assigneeId, status: q.status, workable: q.workable === "true" }) }, 200);
  });

  app.openapi(createRoute({
    method: "get", path: "/v1/cards/{cardId}", request: { params: CardId },
    responses: { 200: card("the card"), 404: errors[404] },
  }), async (c) => c.json(await getCard(db, c.req.valid("param").cardId), 200));

  app.openapi(createRoute({
    method: "get", path: "/v1/cards/{cardId}/context", request: { params: CardId },
    responses: { 200: json(CardContextSchema, "what a worker needs to do the card"), 404: errors[404], 502: errors[502] },
  }), async (c) => c.json(await cardContext(db, blueprint, c.req.valid("param").cardId), 200));

  app.openapi(createRoute({
    method: "post", path: "/v1/cards/{cardId}/comments", request: { params: CardId, body: body(z.object({ text: Text }), "a comment") },
    responses: { 201: json(NoteSchema, "the note"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => c.json(await addComment(db, c.get("actor"), c.get("hop"), c.req.valid("param").cardId, c.req.valid("json").text), 201));

  app.openapi(createRoute({
    method: "post", path: "/v1/cards/{cardId}/handoff",
    request: { params: CardId, body: body(z.object({ toWorkerId: z.string().min(1), text: Text }), "hand the card to the next worker along the chain") },
    responses: { 200: card("the card, now the next worker's"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => {
    const b = c.req.valid("json");
    return c.json(await handOff(db, c.get("actor"), c.get("hop"), c.req.valid("param").cardId, b.toWorkerId, b.text), 200);
  });

  app.openapi(createRoute({
    method: "patch", path: "/v1/cards/{cardId}/status", request: { params: CardId, body: body(z.object({ status: Status }), "the new status") },
    responses: { 200: card("the card"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => c.json(await setStatus(db, c.get("actor"), c.get("hop"), c.req.valid("param").cardId, c.req.valid("json").status), 200));

  app.openapi(createRoute({
    method: "patch", path: "/v1/cards/{cardId}/assignee", request: { params: CardId, body: body(z.object({ workerId: z.string().min(1) }), "the operator re-assigns") },
    responses: { 200: card("the card"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => c.json(await assign(db, c.get("actor"), c.req.valid("param").cardId, c.req.valid("json").workerId), 200));

  app.openapi(createRoute({
    method: "post", path: "/v1/cards/{cardId}/question",
    request: { params: CardId, body: body(z.object({
      text: z.string().min(1).max(2000), proposedDefault: z.string().min(1).max(2000), cases: z.array(z.string().min(1).max(500)).min(1).max(10),
    }), "a question for the operator, with a proposed default") },
    responses: { 201: card("the new question card"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => c.json(await askQuestion(db, c.get("actor"), c.get("hop"), c.req.valid("param").cardId, c.req.valid("json")), 201));

  app.openapi(createRoute({
    method: "post", path: "/v1/cards/{cardId}/answer", request: { params: CardId, body: body(z.object({ answer: Text }), "the operator's answer") },
    responses: { 200: card("the answered question card"), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }), async (c) => c.json(await answerQuestion(db, c.get("actor"), c.req.valid("param").cardId, c.req.valid("json").answer), 200));

  app.openapi(createRoute({
    method: "post", path: "/v1/cards/{cardId}/spec-change/clear", request: { params: CardId },
    responses: { 200: card("the card, spec change cleared"), 403: errors[403], 404: errors[404] },
  }), async (c) => c.json(await clearSpecChange(db, c.get("actor"), c.req.valid("param").cardId), 200));
}
