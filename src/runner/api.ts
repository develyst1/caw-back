// A small client for the CAW HTTP API (SPEC-A-008). The runner knows nothing the API does not tell it (SPEC-C-003 § 1).
// Every write names its actor with X-CAW-Actor. A refused call throws — there is no fallback value anywhere in here.
export type Fetch = (url: string, init?: RequestInit) => Promise<Response> | Response;

export class RunnerApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(`${status} ${code}: ${message}`); }
}

export type Project = {
  id: string; name: string; mode: "manual" | "dispatcher"; hopBudget: number; hopsUsed: number; workspace: { roots: string[] };
  /** the worker who answers the chat (and takes the first card); null until the operator picks one */
  entryWorkerId: string | null;
};
export type Worker = { id: string; name: string; roles: string[]; skills: string[]; model: "opus" | "sonnet" | "haiku"; effort: "low" | "medium" | "high" };
export type Card = {
  id: string; projectId: string; number: number; title: string; todo: string; status: string; assigneeId: string | null;
  kind: "work" | "question"; question: { text: string; proposedDefault: string; cases: string[] } | null; answer: string | null;
};
export type StopReason = "budget_spent" | "nothing_workable" | "failed_review_twice" | "limit_reached" | "operator_stopped" | "error";
export type Run = {
  id: string; projectId: string; mode: "manual" | "dispatcher"; hopBudget: number; startedAt: string; endedAt: string | null;
  stopReason: StopReason | null; report: string | null; hopsUsed: number;
};
export type HopOutcome = "commented" | "handed_off" | "status" | "asked" | "failed" | "stopped" | "interrupted" | "replied" | "proposed" | "amended" | "proposed_and_amended";
/** A hop is on a CARD or on a chat MESSAGE (contract v1.4): exactly one of `cardId` / `messageId` is set. */
export type Hop = {
  id: string; projectId: string; runId: string | null; claimedBy: string | null; cardId: string | null; messageId: string | null; workerId: string;
  startedAt: string; endedAt: string | null; outcome: HopOutcome | null; tokensIn: number | null; tokensOut: number | null; note: string;
  /** contract v1.11: set to `startedAt` by `hop.started`, moved by each heartbeat; never null on the wire. Optional here only so the runner's
   *  test fixtures (main.test.ts, report.test.ts — outside TASK-C-038's file list) need not carry it; the runner never reads it. */
  lastActivityAt?: string;
};
export type ChatQuestion = { text: string; proposedDefault?: string; cases?: string[] };
/** `replyTo` / `questions` make a thread (a worker's reply asks `questions[]`; the operator's next message answers them); `retryRequestedAt` is contract v1.9's retry trigger */
export type ChatMessage = {
  id: string; projectId: string; author: string; text: string; replyHopId: string | null; at: string;
  replyTo: string | null; questions: ChatQuestion[] | null; retryRequestedAt: string | null;
};
export type ApiEvent = { seq: number; projectId: string | null; type: string; actor: string; at: string; data: any };
export type Finish = { outcome: HopOutcome; tokensIn?: number; tokensOut?: number; note?: string };

/** @param actor who every WRITE is made as: `runner:<instance id>` (contract v1.2, SPEC-A-008) — the one place it is decided. The API accepts it
 *  only on runs and hops, which is all the runner writes. Reads send none. */
export function createApi(baseUrl: string, actor: string, fetchFn: Fetch = (url, init) => fetch(url, init)) {
  async function call<T>(method: string, path: string, who: string | null, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (who !== null) headers["x-caw-actor"] = who;
    let res: Response;
    try { res = await fetchFn(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); } catch (e) {
      throw new RunnerApiError(0, "network", `${method} ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    let json: any = null;
    if (text !== "") {
      try { json = JSON.parse(text); } catch { throw new RunnerApiError(res.status, "bad_body", `${method} ${path}: not JSON: ${text.slice(0, 120)}`); }
    }
    if (!res.ok) throw new RunnerApiError(res.status, json?.error?.code ?? "unknown", json?.error?.message ?? `${method} ${path} failed`);
    if (json === null) throw new RunnerApiError(res.status, "bad_body", `${method} ${path}: empty body`);
    return json as T;
  }
  const enc = encodeURIComponent;
  return {
    projects: async () => (await call<{ projects: Project[] }>("GET", "/v1/projects", null)).projects,
    workers: async () => (await call<{ workers: Worker[] }>("GET", "/v1/workers", null)).workers,
    card: (id: string) => call<Card>("GET", `/v1/cards/${enc(id)}`, null),
    /** newest first */
    hops: async (projectId: string, limit = 50) => (await call<{ hops: Hop[] }>("GET", `/v1/projects/${enc(projectId)}/hops?limit=${limit}`, null)).hops,
    events: async (projectId: string, after: number, limit = 500) =>
      (await call<{ events: ApiEvent[] }>("GET", `/v1/projects/${enc(projectId)}/events?after=${after}&limit=${limit}`, null)).events,
    /** newest first */
    runs: async (projectId: string, limit = 20) => (await call<{ runs: Run[] }>("GET", `/v1/projects/${enc(projectId)}/runs?limit=${limit}`, null)).runs,
    startRun: (projectId: string, hopBudget: number) => call<Run>("POST", `/v1/projects/${enc(projectId)}/runs`, actor, { hopBudget }),
    finishRun: (runId: string, input: { stopReason: StopReason; report: string }) => call<Run>("PATCH", `/v1/runs/${enc(runId)}`, actor, input),
    /** the hops of one run, newest first */
    hopsOfRun: async (projectId: string, runId: string) => (await call<{ hops: Hop[] }>("GET", `/v1/projects/${enc(projectId)}/hops?limit=200&runId=${enc(runId)}`, null)).hops,
    /** every card of the project, by card number */
    cards: async (projectId: string) => (await call<{ cards: Card[] }>("GET", `/v1/projects/${enc(projectId)}/cards`, null)).cards,
    /** in the API's order (by card number) */
    workableCards: async (projectId: string) => (await call<{ cards: Card[] }>("GET", `/v1/projects/${enc(projectId)}/cards?workable=true`, null)).cards,
    /** the project's chat, oldest first, after a message id (ids sort by time) */
    chatMessages: async (projectId: string, after?: string) =>
      (await call<{ messages: ChatMessage[] }>("GET", `/v1/projects/${enc(projectId)}/chat?limit=200${after ? `&after=${enc(after)}` : ""}`, null)).messages,
    /** a hop on a CARD (`cardId`) or on a chat message (`messageId`) — exactly one */
    startHop: (projectId: string, input: { cardId?: string; messageId?: string; workerId: string; runId?: string; claim?: string }) =>
      call<Hop>("POST", `/v1/projects/${enc(projectId)}/hops`, actor, input),
    claimHop: (hopId: string, claim: string) => call<Hop>("PATCH", `/v1/hops/${enc(hopId)}`, actor, { claim }),
    /** contract v1.11: "this hop's stream is alive". No body — the core stamps the time and throttles to one write per 60 s (still 200). 409 `hop_not_running` once it ended. */
    heartbeat: (hopId: string) => call<{ lastActivityAt: string }>("POST", `/v1/hops/${enc(hopId)}/heartbeat`, actor),
    finishHop: (hopId: string, finish: Finish) => call<Hop>("PATCH", `/v1/hops/${enc(hopId)}`, actor, finish),
  };
}
export type Api = ReturnType<typeof createApi>;
