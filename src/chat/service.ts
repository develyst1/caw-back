// The project chat (SPEC-A-008 v1.4, REQ-013): the operator's messages, and the entry worker's replies from a chat hop. A message is
// CAW's own words — never spec text. Each write is one event decided inside the write transaction.
import { eq } from "drizzle-orm";
import { chainView } from "../chain/service";
import type { Actor, ChatQuestion, HopOutcome } from "../core/events";
import { newId, now } from "../core/ids";
import type { ChatMessageState, HopState, State } from "../core/reduce";
import { isUuid, loadState } from "../core/state";
import { writeDecided } from "../core/write";
import type { Db } from "../db/client";
import { chatMessages } from "../db/schema";
import { requireOperator, workerIdOf } from "../http/actor";
import { ApiError, notFound } from "../http/errors";
import { chatHopOf } from "./guard";

/** The newest chat hop on a message (v1.9) — computed on read, never stored. Hop ids are time-ordered (core/ids.ts). */
export type ChatHopView = { id: string; endedAt: string | null; outcome: HopOutcome | null };
export type ChatMessage = ChatMessageState & { chatHop: ChatHopView | null };
function chatHopView(s: State, messageId: string): ChatHopView | null {
  const newest = s.hops.filter((h) => h.messageId === messageId).reduce<HopState | null>((a, h) => (a === null || h.id > a.id ? h : a), null);
  return newest && { id: newest.id, endedAt: newest.endedAt, outcome: newest.outcome };
}
export const viewMessage = (s: State, m: ChatMessageState): ChatMessage => ({ ...m, chatHop: chatHopView(s, m.id) });

const projectIn = (s: State) => s.project ?? (() => { throw notFound("project"); })();
/** a message's project is found from its id alone (messages never move) */
async function findMessage(db: Db, messageId: string): Promise<{ projectId: string; state: State; message: ChatMessageState }> {
  const [row] = isUuid(messageId) ? await db.select({ projectId: chatMessages.projectId }).from(chatMessages).where(eq(chatMessages.id, messageId)) : [];
  if (!row) throw notFound("message");
  const state = await loadState(db, row.projectId);
  return { projectId: row.projectId, state, message: state.chat.find((m) => m.id === messageId) ?? (() => { throw notFound("message"); })() };
}

export async function postMessage(db: Db, actor: Actor, projectId: string, text: string): Promise<ChatMessage> {
  requireOperator(actor);
  const id = newId();
  const { state } = await writeDecided(db, projectId, (s) => {
    projectIn(s);
    return { type: "chat.posted", projectId, actor, at: now(), data: { id, text } };
  });
  return viewMessage(state, state.chat.find((m) => m.id === id)!);
}

/** Oldest first; `after` = a message id (the ones newer than it). */
export async function listMessages(db: Db, projectId: string, q: { after?: string; limit: number }): Promise<ChatMessage[]> {
  const s = await loadState(db, projectId);
  projectIn(s);
  return [...s.chat].sort((a, b) => (a.id < b.id ? -1 : 1)).filter((m) => q.after === undefined || m.id > q.after).slice(0, q.limit).map((m) => viewMessage(s, m));
}

/** What a worker needs to answer one message: the message, the chat so far (the last 50 up to and including it), the project, its chain. */
export async function chatContext(db: Db, actor: Actor, hopId: string | null, messageId: string) {
  const { state, message } = await findMessage(db, messageId);
  if (workerIdOf(actor) !== null) chatHopOf(state, actor, hopId, messageId); // the operator may read; a worker only from its running chat hop on it
  const thread = [...state.chat].sort((a, b) => (a.id < b.id ? -1 : 1)).filter((m) => m.id <= message.id).slice(-50);
  return { message: viewMessage(state, message), thread: thread.map((m) => viewMessage(state, m)), project: projectIn(state), chain: chainView(state) };
}

export type ReplyInput = { text: string; questions?: ChatQuestion[]; proposalId?: string; amendment?: { blueprintMessageId: string } };

// The entry worker answers the message its chat hop is on. The asked message gets `replyHopId` (the hop that answered it); a second
// reply is 409 already_answered. The amendment's link is built here from BLUEPRINT_WEB_URL — a worker does not know where Blueprint's web is.
export async function reply(db: Db, actor: Actor, hopId: string | null, messageId: string, input: ReplyInput, webUrl: string): Promise<ChatMessage> {
  const { projectId } = await findMessage(db, messageId);
  const id = newId();
  const { state } = await writeDecided(db, projectId, (s) => {
    const project = projectIn(s);
    const hop = chatHopOf(s, actor, hopId, messageId);
    const asked = s.chat.find((m) => m.id === messageId) ?? (() => { throw notFound("message"); })();
    if (asked.author !== "operator") throw new ApiError(400, "validation", "only an operator message is answered");
    if (asked.replyHopId !== null) throw new ApiError(409, "already_answered", "that message has already been answered");
    if (input.proposalId !== undefined && !s.proposals.some((p) => p.id === input.proposalId)) throw new ApiError(400, "validation", `proposalId: ${input.proposalId} is not a proposal of this project`);
    return { type: "chat.replied", projectId, actor, at: now(), data: {
      id, messageId, hopId: hop.id, text: input.text, questions: input.questions ?? null, proposalId: input.proposalId ?? null,
      amendment: input.amendment ? { blueprintMessageId: input.amendment.blueprintMessageId, link: `${webUrl}/p/${encodeURIComponent(project.blueprintProjectId)}/chat` } : null,
    } };
  });
  return viewMessage(state, state.chat.find((m) => m.id === id)!);
}

// The operator asks for a failed chat step to be tried again (v1.9, D-057). Allowed on an operator message that is not answered and has
// no hop running; a second retry before the runner picks the first up just moves the time (the event is written again).
export async function retryMessage(db: Db, actor: Actor, messageId: string): Promise<void> {
  requireOperator(actor);
  const { projectId } = await findMessage(db, messageId);
  await writeDecided(db, projectId, (s) => {
    const m = s.chat.find((x) => x.id === messageId) ?? (() => { throw notFound("message"); })();
    if (m.author !== "operator") throw new ApiError(400, "not_operator_message", "only an operator message can be retried");
    if (m.replyHopId !== null) throw new ApiError(409, "already_answered", "that message has already been answered");
    if (s.hops.some((h) => h.messageId === messageId && h.endedAt === null)) throw new ApiError(409, "hop_running", "a hop is running on that message");
    return { type: "chat.retry_requested", projectId, actor, at: now(), data: { messageId } };
  });
}
