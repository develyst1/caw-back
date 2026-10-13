// The MCP server a worker is given (SPEC-A-008 § MCP server, REQ-010 R10): stdio, and a thin adapter over the CAW HTTP
// API — every tool is one API call carrying `X-CAW-Actor: worker:<CAW_WORKER_ID>`, so the API's rules (own cards only, chain
// edges, question cards …) apply unchanged and live in one place. The results are the API's JSON; an API error comes back as
// a tool error whose text is the API's own error body, so the model sees the code (`not_your_card`, `chain_broken` …).
//   env: CAW_API_URL (default http://127.0.0.1:4500) · CAW_WORKER_ID (required — refuses to start without it)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type Result = { content: { type: "text"; text: string }[]; isError?: true };
const ok = (json: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(json) }] });
const fail = (error: { code: string; message: string; details?: unknown }): Result => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] });

export type McpOptions = { apiUrl: string; workerId: string; fetch?: (input: string, init?: RequestInit) => Promise<Response> };

export function createMcpServer({ apiUrl, workerId, fetch: fetchImpl = (input, init) => fetch(input, init) }: McpOptions): McpServer {
  const actor = `worker:${workerId}`;

  // one HTTP call: the parsed JSON on success, or the error to hand back as a tool error
  async function api(method: string, path: string, body?: unknown): Promise<{ json: any } | { error: Result }> {
    let res: Response;
    try {
      res = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers: { "x-caw-actor": actor, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
  }, ({ cardId, text }) => run("POST", `/v1/cards/${id(cardId)}/comments`, { text }));

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

  return server;
}

if (import.meta.main) {
  const workerId = process.env.CAW_WORKER_ID ?? "";
  if (!workerId) {
    console.error("CAW_WORKER_ID is required: the id of the CAW worker this MCP server acts as");
    process.exit(1);
  }
  const server = createMcpServer({ apiUrl: process.env.CAW_API_URL || "http://127.0.0.1:4500", workerId });
  await server.connect(new StdioServerTransport());
}
