// The MCP server a worker is given (SPEC-A-008 § MCP server, REQ-010 R10): stdio, and a thin adapter over the CAW HTTP
// API — every tool is one API call carrying `X-CAW-Actor: worker:<CAW_WORKER_ID>`, so the API's rules (own cards only, chain
// edges, question cards …) apply unchanged and live in one place. The results are the API's JSON; an API error comes back as
// a tool error whose text is the API's own error body, so the model sees the code (`not_your_card`, `chain_broken` …).
//   env: CAW_API_URL (default http://127.0.0.1:4500) · CAW_WORKER_ID (required — refuses to start without it) ·
//        CAW_HOP_ID (the worker's running hop, set by the runner per hop; without it every write tool answers hop_required)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type Result = { content: { type: "text"; text: string }[]; isError?: true };
const ok = (json: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(json) }] });
// v1.13 (D-078): a model types the two characters backslash + n where it means a line break. `comment` and `reply` turn every such pair into a
// real line feed before the API call; nothing else in the text changes. Only these two tools — the HTTP API and the core store text as sent.
const lineBreaks = (text: string): string => text.replaceAll("\\n", "\n");
const fail = (error: { code: string; message: string; details?: unknown }): Result => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] });

// hopId = the worker's running hop (v1.5, D-054): sent as X-CAW-Hop on every call; without it every write answers hop_required
export type McpOptions = { apiUrl: string; workerId: string; hopId?: string; fetch?: (input: string, init?: RequestInit) => Promise<Response> };

export function createMcpServer({ apiUrl, workerId, hopId, fetch: fetchImpl = (input, init) => fetch(input, init) }: McpOptions): McpServer {
  const actor = `worker:${workerId}`;

  // one HTTP call: the parsed JSON on success, or the error to hand back as a tool error
  async function api(method: string, path: string, body?: unknown): Promise<{ json: any } | { error: Result }> {
    let res: Response;
    try {
      res = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers: { "x-caw-actor": actor, ...(hopId ? { "x-caw-hop": hopId } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return { error: fail({ code: "caw_unreachable", message: `the CAW API at ${apiUrl} did not answer` }) };
    }
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (res.ok && json !== undefined) return { json };
    if (json?.error?.code) return { error: fail(json.error) };
    return { error: fail({ code: `http_${res.status}`, message: "the CAW API answered something that is not its JSON" }) };
  }
  const run = async (method: string, path: string, body?: unknown): Promise<Result> => {
    const r = await api(method, path, body);
    return "error" in r ? r.error : ok(r.json);
  };
  const id = encodeURIComponent;

  const server = new McpServer({ name: "caw", version: "1.0.0" });

  server.registerTool("my_cards", {
    title: "My cards",
    description: "The cards assigned to you, the ones you can work on now (workable) first. Optionally only one project's.",
    inputSchema: { projectId: z.string().optional().describe("a CAW project id; omit for every project") },
  }, async ({ projectId }) => {
    let ids: string[];
    if (projectId !== undefined) ids = [projectId];
    else {
      const list = await api("GET", "/v1/projects");
      if ("error" in list) return list.error;
      ids = list.json.projects.map((p: { id: string }) => p.id);
    }
    const cards: { workable: boolean; createdAt: string; number: number }[] = [];
    for (const pid of ids) {
      const r = await api("GET", `/v1/projects/${id(pid)}/cards?assigneeId=${id(workerId)}`);
      if ("error" in r) return r.error;
      cards.push(...r.json.cards);
    }
    cards.sort((a, b) => Number(b.workable) - Number(a.workable) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number));
    return ok({ cards });
  });

  server.registerTool("card_context", {
    title: "Card context",
    description: "Everything you need to do a card: the card, the part of the confirmed spec it is anchored to (as Blueprint has it), the notes on it (oldest first) and the decisions already made for it.",
    inputSchema: { cardId: z.string().min(1) },
  }, ({ cardId }) => run("GET", `/v1/cards/${id(cardId)}/context`));

  server.registerTool("comment", {
    title: "Comment on a card",
    description: "Add a comment (a note) to a card assigned to you. Notes are never edited or deleted.",
    inputSchema: { cardId: z.string().min(1), text: z.string().min(1).describe("1–8 000 characters") },
  }, ({ cardId, text }) => run("POST", `/v1/cards/${id(cardId)}/comments`, { text: lineBreaks(text) }));

  server.registerTool("hand_off", {
    title: "Hand a card to the next worker",
    description: "Pass a card assigned to you to another worker. Only along the project's chain: an edge from you to them must exist, or the call fails with chain_broken and lists who you may hand to.",
    inputSchema: { cardId: z.string().min(1), toWorkerId: z.string().min(1), text: z.string().min(1).describe("what you did and what they should do next") },
  }, ({ cardId, toWorkerId, text }) => run("POST", `/v1/cards/${id(cardId)}/handoff`, { toWorkerId, text }));

  server.registerTool("set_status", {
    title: "Set a card's status",
    description: "Move a card assigned to you: todo, doing, review, done or stuck. `doing` is refused (waiting_on_question) while a card it depends on is not done.",
    inputSchema: { cardId: z.string().min(1), status: z.enum(["todo", "doing", "review", "done", "stuck"]) },
  }, ({ cardId, status }) => run("PATCH", `/v1/cards/${id(cardId)}/status`, { status }));

  server.registerTool("ask_operator", {
    title: "Ask the operator",
    description: "When you cannot go on without a decision: open a question card for the operator, with your proposed default and the cases it covers. Your card then waits until the operator answers.",
    inputSchema: {
      cardId: z.string().min(1).describe("the card you are working on"),
      text: z.string().min(1).describe("the question"),
      proposedDefault: z.string().min(1).describe("what you will do if the operator agrees"),
      cases: z.array(z.string().min(1)).min(1).max(10).describe("the situations the answer must cover"),
    },
  }, ({ cardId, text, proposedDefault, cases }) => run("POST", `/v1/cards/${id(cardId)}/question`, { text, proposedDefault, cases }));

  // ---------- chat (v1.4, REQ-013): the entry worker's chat hop ----------
  const Questions = z.array(z.object({ text: z.string().min(1), proposedDefault: z.string().min(1), cases: z.array(z.string().min(1)).min(1).max(10) })).max(10);
  const Item = z.object({
    title: z.string().min(1).describe("the card's title (1–200 characters)"), todo: z.string().describe("what to do"),
    anchor: z.object({ key: z.string().min(1), version: z.number().int().min(0).optional() }).describe("a part `locate` found; send its key — the version is optional and ignored (REQ-105)"),
    workerId: z.string().min(1).describe("the chain member who gets the card"),
    dependsOn: z.array(z.number().int().min(0)).default([]).describe("indexes of the items in this list that must be done first"),
    hops: z.number().int().min(1).describe("your estimate of the hops this card needs"),
  });

  server.registerTool("chat_context", {
    title: "Chat context",
    description: "Everything you need to answer the operator's chat message: the message, the chat so far, the project and its chain (who is in it, who may hand to whom). Only while your chat hop on that message is running.",
    inputSchema: { messageId: z.string().min(1) },
  }, ({ messageId }) => run("GET", `/v1/chat/${id(messageId)}/context`));

  server.registerTool("locate", {
    title: "Find parts of the spec",
    description: "Ask Blueprint which parts of the confirmed spec a request touches. Returns Blueprint's answer: candidate parts (key, kind, title, score). You may propose cards only on keys you located in this hop.",
    inputSchema: { projectId: z.string().min(1), request: z.string().min(1).describe("1–1 000 characters") },
  }, ({ projectId, request }) => run("POST", `/v1/projects/${id(projectId)}/locate`, { request }));

  server.registerTool("propose_cards", {
    title: "Propose cards",
    description: "Propose cards for the operator's message — 1 to 50 items, each anchored on a part you located. The operator accepts them; nothing is made until then. A new proposal replaces your earlier open one on the same message. Pass the returned id as `proposalId` to `reply`.",
    inputSchema: { projectId: z.string().min(1), messageId: z.string().min(1), items: z.array(Item).min(1).max(50) },
  }, ({ projectId, messageId, items }) => run("POST", `/v1/projects/${id(projectId)}/proposals`, { messageId, items }));

  server.registerTool("send_amendment", {
    title: "Send a spec change request to Blueprint",
    description: "Ask Blueprint's chat to change the spec (the spec is not touched: a question pack comes of it). `about` = keys of the parts it concerns. Returns Blueprint's message; pass its id as `amendment.blueprintMessageId` to `reply`.",
    inputSchema: { projectId: z.string().min(1), request: z.string().min(1).describe("1–4 000 characters"), about: z.array(z.string().min(1)).max(20).optional() },
  }, ({ projectId, request, about }) => run("POST", `/v1/projects/${id(projectId)}/amendments`, { request, ...(about ? { about } : {}) }));

  // v1.16 (REQ-015 R2a): the setup step's result. The model gets the project id from chat_context, as for locate / propose_cards.
  server.registerTool("save_code_map", {
    title: "Save the code map",
    description: "The result of the setup step \"get to know the code\": the folders (name, fe | be | other, a short note), the stack, the run and test commands, the rules found (an empty list when there are none) and open questions with your proposed default. Only the project's entry worker, from its chat hop. Saving again replaces the map and the operator has to confirm it again.",
    inputSchema: {
      projectId: z.string().min(1),
      folders: z.array(z.object({ name: z.string().min(1).max(500), kind: z.enum(["fe", "be", "other"]), note: z.string().min(1).max(500).optional() })).min(1).max(50),
      stack: z.array(z.string().min(1).max(500)).max(50), commands: z.object({ run: z.array(z.string().min(1).max(500)).max(50), test: z.array(z.string().min(1).max(500)).max(50) }),
      rules: z.array(z.string().min(1).max(500)).max(50), questions: z.array(z.object({ text: z.string().min(1).max(500), proposedDefault: z.string().min(1).max(500) })).max(50),
      notes: z.string().min(1).max(2000).optional(),
    },
  }, ({ projectId, ...map }) => run("PUT", `/v1/projects/${id(projectId)}/code-map`, map));

  server.registerTool("reply", {
    title: "Reply in the chat",
    description: "Answer the operator's message (once). Optionally with questions for the operator, the proposal you made (`proposalId`) and the amendment you sent (`amendment.blueprintMessageId`).",
    inputSchema: {
      messageId: z.string().min(1), text: z.string().min(1).describe("1–4 000 characters"), questions: Questions.optional(),
      proposalId: z.string().min(1).optional(), amendment: z.object({ blueprintMessageId: z.string().min(1) }).optional(),
    },
  }, ({ messageId, text, questions, proposalId, amendment }) =>
    run("POST", `/v1/chat/${id(messageId)}/reply`, { text: lineBreaks(text), ...(questions ? { questions } : {}), ...(proposalId ? { proposalId } : {}), ...(amendment ? { amendment } : {}) }));

  return server;
}

if (import.meta.main) {
  const workerId = process.env.CAW_WORKER_ID ?? "";
  if (!workerId) {
    console.error("CAW_WORKER_ID is required: the id of the CAW worker this MCP server acts as");
    process.exit(1);
  }
  const server = createMcpServer({ apiUrl: process.env.CAW_API_URL || "http://127.0.0.1:4500", workerId, hopId: process.env.CAW_HOP_ID || undefined });
  await server.connect(new StdioServerTransport());
}
