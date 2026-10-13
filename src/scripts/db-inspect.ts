// `bun run db:inspect` — READ ONLY. What CAW already has in the database named by DATABASE_URL, and which of the study's cases
// it is (studies/CAW-MIGRATE-42P07-2026-10-14.md, Step 1): the operator runs it on SIT and pastes the output to the PM.
// One `BEGIN READ ONLY` … `ROLLBACK`; nothing is written. DATABASE_URL is a Postgres URL, or `pglite:memory` / `pglite:file:<dir>`
// (opened raw — NOT migrated). Never prints the URL, a host, a user or an error message — only fixed text and the error code.
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";

export type Row = Record<string, unknown>;
/** One statement at a time, on one connection (so BEGIN … ROLLBACK wraps what follows). */
export type Client = { exec(text: string): Promise<Row[]>; close(): Promise<void> };

export async function openClient(url: string): Promise<Client> {
  if (url === "pglite:memory" || url.startsWith("pglite:file:")) {
    const pg = new PGlite(url === "pglite:memory" ? undefined : url.slice("pglite:file:".length));
    await pg.waitReady;
    return { exec: async (text) => (await pg.query(text)).rows as Row[], close: () => pg.close() };
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  return { exec: async (text) => [...(await sql.unsafe(text))] as Row[], close: () => sql.end() };
}

/** The two migrations the study names: `created_at` = `when` of CAW's `meta/_journal.json`. */
export const CAW_CREATED_AT = ["1791880568915", "1791880569138"] as const;

export type Verdict = "CASE A" | "CASE B" | "CASE C" | "CLEAN" | "MIGRATED";
export type Inspection = {
  tables: string[];
  cawJournal: { exists: boolean; createdAt: string[] };
  counts: { events: number | null; projects: number | null; workers: number | null };
  drizzleJournal: { exists: boolean; rows: { createdAt: string; hash: string }[] };
  verdict: Verdict;
};

const exists = async (q: Client["exec"], rel: string) => (await q(`SELECT to_regclass('${rel}') IS NOT NULL AS ok`))[0]!.ok === true;

/** Reads only. Run it inside a transaction the caller opened (READ ONLY for `db:inspect`; the fix's own for its guard). */
export async function readState(q: Client["exec"]): Promise<Inspection> {
  const tables = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'caw' ORDER BY 1`)).map((r) => String(r.table_name));
  const cawExists = await exists(q, "caw.__caw_migrations");
  const cawJournal = { exists: cawExists, createdAt: cawExists ? (await q(`SELECT created_at::text AS c FROM caw.__caw_migrations ORDER BY created_at`)).map((r) => String(r.c)) : [] };
  const count = async (t: string) => ((await exists(q, `caw.${t}`)) ? Number((await q(`SELECT count(*)::int AS n FROM caw.${t}`))[0]!.n) : null);
  const counts = { events: await count("events"), projects: await count("projects"), workers: await count("workers") };
  const dExists = await exists(q, "drizzle.__drizzle_migrations");
  const drizzleJournal = {
    exists: dExists,
    rows: dExists ? (await q(`SELECT created_at::text AS c, left(hash, 12) AS h FROM drizzle.__drizzle_migrations ORDER BY created_at`)).map((r) => ({ createdAt: String(r.c), hash: String(r.h) })) : [],
  };
  return { tables, cawJournal, counts, drizzleJournal, verdict: verdictOf(tables, cawJournal, counts, drizzleJournal) };
}

function verdictOf(tables: string[], caw: Inspection["cawJournal"], counts: Inspection["counts"], drizzle: Inspection["drizzleJournal"]): Verdict {
  const ours = drizzle.rows.filter((r) => (CAW_CREATED_AT as readonly string[]).includes(r.createdAt));
  const noData = Object.values(counts).every((n) => !n);
  const cawHasBoth = caw.createdAt.length === 2 && CAW_CREATED_AT.every((c) => caw.createdAt.includes(c));
  if (tables.length === 0) return ours.length === 0 && caw.createdAt.length === 0 ? "CLEAN" : "CASE C";
  // Case A: both of CAW's rows are in Blueprint's journal (exactly once each) and CAW's own journal is absent or empty
  if (ours.length === 2 && new Set(ours.map((r) => r.createdAt)).size === 2 && caw.createdAt.length === 0) return "CASE A";
  // Case B: tables of unknown origin — in no journal — and no data
  if (ours.length === 0 && caw.createdAt.length === 0 && noData) return "CASE B";
  // Healthy: CAW's journal holds both, Blueprint's holds none of ours (the study never calls this B)
  if (ours.length === 0 && cawHasBoth) return "MIGRATED";
  return "CASE C";
}

export const DB_INSPECT_VERDICTS: Record<Verdict, string> = {
  "CASE A": "the two CAW rows are in Blueprint's journal → `bun run db:fix-journal`, then `bun run db:migrate`",
  "CASE B": "tables of unknown origin, no data, in no journal → the study's Case B (DROP SCHEMA caw) — send this output to the PM first",
  "CASE C": "anything else — STOP; send this output to the PM",
  CLEAN: "no caw tables at all → just `bun run db:migrate`",
  MIGRATED: "already migrated: caw.__caw_migrations holds both rows, Blueprint's journal none of ours → nothing to do",
};

export function render(r: Inspection): string[] {
  const n = (v: number | null) => (v === null ? "n/a" : String(v));
  return [
    r.tables.length ? `caw tables (${r.tables.length}): ${r.tables.join(", ")}` : "caw tables: none",
    r.cawJournal.exists ? `caw.__caw_migrations: ${r.cawJournal.createdAt.length} rows${r.cawJournal.createdAt.length ? ` — created_at ${r.cawJournal.createdAt.join(", ")}` : ""}` : "caw.__caw_migrations: absent",
    `rows: events ${n(r.counts.events)} · projects ${n(r.counts.projects)} · workers ${n(r.counts.workers)}`,
    r.drizzleJournal.exists ? `drizzle.__drizzle_migrations: ${r.drizzleJournal.rows.length} rows (created_at  hash)` : "drizzle.__drizzle_migrations: absent",
    ...r.drizzleJournal.rows.map((x) => `  ${x.createdAt}  ${x.hash}${(CAW_CREATED_AT as readonly string[]).includes(x.createdAt) ? "   ← CAW's" : ""}`),
    `verdict: ${r.verdict}`,
  ];
}

/** The whole read, in one READ ONLY transaction that is always rolled back. */
export async function inspect(client: Client): Promise<Inspection> {
  await client.exec("BEGIN READ ONLY");
  try {
    return await readState(client.exec);
  } finally {
    await client.exec("ROLLBACK");
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL ?? "";
  let client: Client | undefined;
  try {
    if (!url) throw Object.assign(new Error(), { code: "no DATABASE_URL" });
    client = await openClient(url);
    const result = await inspect(client);
    for (const line of render(result)) console.log(line);
    console.log(`next: ${DB_INSPECT_VERDICTS[result.verdict]}`);
  } catch (err) {
    // the driver wraps the Postgres error: its code is on `cause`; the message may hold a host or a password — never printed
    const e = err as { code?: string; cause?: { code?: string } };
    console.log(`db:inspect failed — code ${e.code ?? e.cause?.code ?? "none"}`);
    process.exitCode = 1;
  } finally {
    await client?.close().catch(() => {});
  }
}
