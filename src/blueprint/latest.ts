// Reading the CURRENT spec (REQ-105, SPEC-107 D3–D5). Blueprint serves no old revision, so CAW keeps what it read, in two operational tables (not replayed):
//   spec_parts — the last body read per (project, key): the fallback when Blueprint is down (AC-5);
//   hop_spec   — the body a card hop was given at its start: what that hop keeps reading, even after the spec moves on (AC-2).
import { and, eq } from "drizzle-orm";
import { now } from "../core/ids";
import type { Db } from "../db/client";
import { hopSpec, specParts } from "../db/schema";
import { BlueprintUnreachable, type Blueprint } from "./client";

export type LatestRead = { body: unknown; revision: number; readAt: string; fromCache: boolean };
type ProjectRef = { id: string; blueprintProjectId: string };

/** The revision a v2 part-context carries. A 200 without one is not a v2 answer: it is treated as Blueprint failing, so the cache (if any) is used instead of a guess. */
function revisionOf(body: unknown): number {
  const r = (body as { revision?: unknown } | null)?.revision;
  if (typeof r !== "number" || !Number.isInteger(r) || r < 0) throw new BlueprintUnreachable("no revision in the part context");
  return r;
}

/** The label a read carries (`latestLabel` in a v2 part context), as the pair a card or proposal stores: its number (D2: 0 = none) and its words. */
export function labelOf(body: unknown): { version: number; label: string | null } {
  const l = (body as { latestLabel?: { version?: unknown; label?: unknown } | null } | null)?.latestLabel;
  return l && typeof l.version === "number" && Number.isInteger(l.version) && l.version > 0 ? { version: l.version, label: typeof l.label === "string" ? l.label : null } : { version: 0, label: null };
}

/** The anchor a card is cut with from one read: key + label number (D2) + label words + the spec revision (stored in the `card.created` event). */
export const cardAnchor = (key: string, read: { body: unknown; revision: number }) => { const l = labelOf(read.body); return { key, version: l.version, label: l.label, revision: read.revision }; };

/** D4 — ONE cache-aware read of a part of the current spec.
 *  200 → the body is saved (replacing the old one) and returned `fromCache: false` · 404 (the key is not live) → `null`, and a saved body for it goes (a removed part must not come back from the cache later)
 *  · Blueprint not answering → the saved body as `fromCache: true`; with none saved, the `BlueprintUnreachable` is rethrown (→ 502 as before). */
export async function readLatestPart(db: Db, blueprint: Blueprint, project: ProjectRef, key: string): Promise<LatestRead | null> {
  try {
    const body = await blueprint.specContext(project.blueprintProjectId, key);
    if (body === null) {
      await db.delete(specParts).where(and(eq(specParts.projectId, project.id), eq(specParts.key, key)));
      return null;
    }
    const revision = revisionOf(body);
    const readAt = new Date(now());
    const row = { projectId: project.id, key, revision, body: body as object, readAt };
    await db.insert(specParts).values(row).onConflictDoUpdate({ target: [specParts.projectId, specParts.key], set: { revision, body: row.body, readAt } });
    return { body, revision, readAt: readAt.toISOString(), fromCache: false };
  } catch (e) {
    if (!(e instanceof BlueprintUnreachable)) throw e;
    const [saved] = await db.select().from(specParts).where(and(eq(specParts.projectId, project.id), eq(specParts.key, key)));
    if (!saved) throw e;
    return { body: saved.body, revision: saved.revision, readAt: saved.readAt.toISOString(), fromCache: true };
  }
}

/** D5 — pin a card hop's start text. Called by the route after `startHop` has committed. It NEVER fails the hop: a part that is not live, Blueprint down with nothing saved, or a database
 *  error is one codes-only log line (a database error's message can hold spec text), and `card_context` then falls back to the latest read. Returns whether a pin was written. */
export async function pinHop(db: Db, blueprint: Blueprint, project: ProjectRef, hopId: string, anchorKey: string, log: (line: string) => void = (l) => console.error(l)): Promise<boolean> {
  try {
    const read = await readLatestPart(db, blueprint, project, anchorKey);
    if (read === null) { log(`[pin] hop ${hopId}: ${anchorKey} is not in the current spec — not pinned`); return false; }
    await db.insert(hopSpec).values({ hopId, revision: read.revision, body: read.body as object, readAt: new Date(read.readAt), fromCache: read.fromCache }).onConflictDoNothing();
    return true;
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code;
    log(`[pin] hop ${hopId}: not pinned — ${e instanceof BlueprintUnreachable ? e.message : `${(e as Error).name}${code ? ` code=${code}` : ""}`}`);
    return false;
  }
}

/** The pin of a hop, if it has one. */
export async function pinnedRead(db: Db, hopId: string): Promise<LatestRead | null> {
  const [row] = await db.select().from(hopSpec).where(eq(hopSpec.hopId, hopId));
  return row ? { body: row.body, revision: row.revision, readAt: row.readAt.toISOString(), fromCache: row.fromCache } : null;
}
