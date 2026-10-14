// "Holds a running chat hop" (SPEC-A-008 v1.4 + v1.5), the one rule behind every chat-only route: a `worker:<id>` must present
// (`X-CAW-Hop`) a hop of its own that is running and is a CHAT hop — on the given message, or (messageId undefined) on any message of the
// project. Missing header → 400 hop_required; any other hop → 403 not_your_message { hopId, endedAt, outcome }. The operator is not a
// worker: the caller decides what the operator may do (read routes, accept — not reply / propose).
import type { Actor } from "../core/events";
import type { HopState, State } from "../core/reduce";
import { workerIdOf } from "../http/actor";
import { ApiError } from "../http/errors";

export function chatHopOf(s: State, actor: Actor, hopId: string | null, messageId?: string): HopState {
  const wid = workerIdOf(actor);
  if (wid === null) throw new ApiError(403, "not_your_message", "only a worker with a running chat hop may do this");
  if (hopId === null) throw new ApiError(400, "hop_required", "a worker writes only from a running hop: send X-CAW-Hop with the id of your chat hop");
  const hop = s.hops.find((h) => h.id === hopId);
  if (!hop || hop.workerId !== wid || hop.endedAt !== null || hop.messageId === null || (messageId !== undefined && hop.messageId !== messageId)) {
    throw new ApiError(403, "not_your_message", "that is not a running chat hop of yours on this message", { hopId, endedAt: hop?.endedAt ?? null, outcome: hop?.outcome ?? null });
  }
  return hop;
}
