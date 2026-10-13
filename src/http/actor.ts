// The X-CAW-Actor rule (SPEC-A-008 § Identity): every write names its actor — `operator` or `worker:<workerId>`.
// Missing / malformed → 400 actor_required; a worker id CAW does not know → 400 unknown_worker. No auth in v1 (localhost only).
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Actor } from "../core/events";
import type { Db } from "../db/client";
import { workers } from "../db/schema";
import { ApiError } from "./errors";

export type Env = { Variables: { actor: Actor } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Not a caller's write: Blueprint's push (it has no actor to name) and the check that writes nothing.
const NO_ACTOR = [/^\/v1\/notify$/, /^\/v1\/projects\/[^/]+\/rebuild-check$/];

export const actorRule = (db: Db): MiddlewareHandler<Env> => async (c, next) => {
  if (!WRITES.has(c.req.method) || NO_ACTOR.some((r) => r.test(c.req.path))) return next();
  const raw = c.req.header("x-caw-actor");
  const worker = raw?.startsWith("worker:") ? raw.slice("worker:".length) : null;
  if (raw !== "operator" && !(worker !== null && UUID.test(worker))) {
    throw new ApiError(400, "actor_required", "send X-CAW-Actor: operator or X-CAW-Actor: worker:<workerId>");
  }
  if (worker !== null) {
    const [known] = await db.select({ id: workers.id }).from(workers).where(eq(workers.id, worker));
    if (!known) throw new ApiError(400, "unknown_worker", `no worker ${worker}`);
  }
  c.set("actor", raw as Actor);
  return next();
};

/** Project, worker, chain, mode and re-assign writes are the operator's alone → a worker gets 403 operator_only. */
export function requireOperator(actor: Actor): void {
  if (actor !== "operator") throw new ApiError(403, "operator_only", "only the operator may do this");
}

/** The worker id of a `worker:<id>` actor; null for the operator. */
export const workerIdOf = (actor: Actor): string | null => (actor === "operator" ? null : actor.slice("worker:".length));
