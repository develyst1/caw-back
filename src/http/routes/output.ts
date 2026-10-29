// What a hop's CLI showed (REQ-104, SPEC-103 § API): the runner writes batches, a screen reads them. Rows live in `hop_output`
// — operational, not an event, not replayed — so these routes touch no project state and take no write lock.
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, gt } from "drizzle-orm";
import { isUuid } from "../../core/state";
import type { Db } from "../../db/client";
import { hopOutput, hops } from "../../db/schema";
import type { Env } from "../actor";
import { ApiError, errors, notFound } from "../errors";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T, description: string) => ({ ...json(schema, description), required: true as const });

const Kind = z.enum(["line", "gap", "truncated"]);
const EntrySchema = z.object({
  seq: z.number().int().min(0).openapi({ description: "increasing per hop, not contiguous (a dropped line leaves a hole)" }),
  at: z.string().openapi({ description: "ISO 8601: when the runner saw the line" }),
  kind: Kind,
  text: z.string().max(2000).openapi({ description: "the rendered, redacted line for `line`; \"\" for `gap` and `truncated`" }),
  gapSeconds: z.number().int().min(1).nullable().openapi({ description: "required for `gap`, null otherwise" }),
}).openapi("HopOutputEntry");

// On input `text` and `gapSeconds` may be left out; a `gap` must say how long, and only a `gap` may.
const EntryIn = z.object({
  seq: z.number().int().min(0), at: z.iso.datetime({ offset: true }), kind: Kind,
  text: z.string().max(2000).default(""), gapSeconds: z.number().int().min(1).nullish(),
}).refine((e) => (e.kind === "gap") === (e.gapSeconds != null), "gapSeconds is required for a gap entry and only for a gap entry");

const HopId = z.object({ hopId: z.string() });

const hopExists = async (db: Db, hopId: string) => {
  const [row] = isUuid(hopId) ? await db.select({ id: hops.id }).from(hops).where(eq(hops.id, hopId)) : [];
  if (!row) throw notFound("hop");
};

export function outputRoutes(app: OpenAPIHono<Env>, db: Db) {
  app.openapi(createRoute({
    method: "post", path: "/v1/hops/{hopId}/output", request: { params: HopId, body: body(z.object({ entries: z.array(EntryIn).min(1).max(200) }), "a batch of what the hop's CLI showed") },
    responses: { 202: json(z.object({ stored: z.number().int() }), "how many entries were NEW; a (hopId, seq) already stored is skipped"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }), async (c) => {
    if (!c.get("actor").startsWith("runner:")) throw new ApiError(403, "runner_only", "only a runner sends a hop's output");
    const { hopId } = c.req.valid("param");
    await hopExists(db, hopId);
    const stored = await db.insert(hopOutput)
      .values(c.req.valid("json").entries.map((e) => ({ hopId, seq: e.seq, at: new Date(e.at), kind: e.kind, text: e.text, gapSeconds: e.gapSeconds ?? null })))
      .onConflictDoNothing()
      .returning({ seq: hopOutput.seq });
    return c.json({ stored: stored.length }, 202);
  });

  app.openapi(createRoute({
    method: "get", path: "/v1/hops/{hopId}/output",
    request: { params: HopId, query: z.object({ after: z.coerce.number().int().default(-1), limit: z.coerce.number().int().min(1).max(1000).default(500) }) },
    responses: { 200: json(z.object({ hopId: z.string(), entries: z.array(EntrySchema), more: z.boolean() }), "entries with seq > after, ascending, at most `limit`; `more` = there are further ones"), 400: errors[400], 404: errors[404] },
  }), async (c) => {
    const { hopId } = c.req.valid("param");
    const { after, limit } = c.req.valid("query");
    await hopExists(db, hopId);
    const rows = await db.select().from(hopOutput).where(and(eq(hopOutput.hopId, hopId), gt(hopOutput.seq, after))).orderBy(asc(hopOutput.seq)).limit(limit + 1);
    const entries = rows.slice(0, limit).map((r) => ({ seq: r.seq, at: r.at.toISOString(), kind: r.kind as z.infer<typeof Kind>, text: r.text, gapSeconds: r.gapSeconds }));
    return c.json({ hopId, entries, more: rows.length > limit }, 200);
  });
}
