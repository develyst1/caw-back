// The X-CAW-Actor rule (SPEC-A-008 § Identity): every write names its actor — `operator`, `worker:<workerId>` or, for Team C's
// runner (v1.2), `runner:<name>`. Missing / malformed → 400 actor_required; a worker id CAW does not know → 400 unknown_worker;
// a runner on any write but its four routes → 403 runner_not_allowed. No auth in v1 (localhost only).
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Actor } from "../core/events";
import type { Db } from "../db/client";
import { workers } from "../db/schema";
import { ApiError } from "./errors";

/** `hop` = the `X-CAW-Hop` header (v1.5): the hop a `worker:<id>` writes from; null when absent or empty. */
export type Env = { Variables: { actor: Actor; hop: string | null } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Not a caller's write: Blueprint's push (it has no actor to name) and the check that writes nothing.
const NO_ACTOR = [/^\/v1\/notify$/, /^\/v1\/projects\/[^/]+\/rebuild-check$/];
// The only writes a `runner:<name>` may make: open / finish a run, start / finish-or-claim a hop (SPEC § v1.2).
const RUNNER_ROUTES: { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/v1\/projects\/[^/]+\/runs$/ },
  { method: "PATCH", path: /^\/v1\/runs\/[^/]+$/ },
  { method: "POST", path: /^\/v1\/projects\/[^/]+\/hops$/ },
  { method: "PATCH", path: /^\/v1\/hops\/[^/]+$/ },
];
const RUNNER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export const actorRule = (db: Db): MiddlewareHandler<Env> => async (c, next) => {
  if (!WRITES.has(c.req.method)) {
    // A read needs no actor. A well-formed one is passed on all the same (the chat context route answers a worker only from its
    // running chat hop); anything else reads as the operator, who may call every read route.
    const given = c.req.header("x-caw-actor");
    const ok = given === "operator" || (given?.startsWith("worker:") && UUID.test(given.slice("worker:".length)));
    c.set("actor", (ok ? given : "operator") as Actor);
    c.set("hop", c.req.header("x-caw-hop") || null);
    return next();
  }
  if (NO_ACTOR.some((r) => r.test(c.req.path))) return next();
  const raw = c.req.header("x-caw-actor");
  const worker = raw?.startsWith("worker:") ? raw.slice("worker:".length) : null;
  const runner = raw?.startsWith("runner:") ? raw.slice("runner:".length) : null;
  if (raw !== "operator" && !(worker !== null && UUID.test(worker)) && !(runner !== null && RUNNER_NAME.test(runner))) {
    throw new ApiError(400, "actor_required", "send X-CAW-Actor: operator, worker:<workerId> or runner:<name> (name = letters, digits, _ and -, 1–64)");
  }
  if (runner !== null && !RUNNER_ROUTES.some((r) => r.method === c.req.method && r.path.test(c.req.path))) {
    throw new ApiError(403, "runner_not_allowed", "a runner may only open / finish runs and start / finish / claim hops");
  }
  if (worker !== null) {
    const [known] = await db.select({ id: workers.id }).from(workers).where(eq(workers.id, worker));
    if (!known) throw new ApiError(400, "unknown_worker", `no worker ${worker}`);
  }
  c.set("actor", raw as Actor);
  c.set("hop", c.req.header("x-caw-hop") || null);
  return next();
};

/** Project, worker, chain, mode and re-assign writes are the operator's alone → a worker gets 403 operator_only (a runner never gets this far: the middleware stopped it). */
export function requireOperator(actor: Actor): void {
  if (actor !== "operator") throw new ApiError(403, "operator_only", "only the operator may do this");
}

/** The worker id of a `worker:<id>` actor; null for the operator. */
export const workerIdOf = (actor: Actor): string | null => (actor.startsWith("worker:") ? actor.slice("worker:".length) : null);
