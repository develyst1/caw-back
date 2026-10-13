// `bun run db:fix-journal` — the study's Case A and nothing else (studies/CAW-MIGRATE-42P07-2026-10-14.md, Step 2): CAW's two
// journal rows went into Blueprint's `drizzle.__drizzle_migrations` (an old `db:migrate` used drizzle's default journal); move
// them to `caw.__caw_migrations`, where `db:migrate` now looks, and take them out of Blueprint's. One transaction:
//   BEGIN → re-read the state, and refuse unless it is CASE A → create caw.__caw_migrations if missing → INSERT … SELECT the 2 rows →
//   DELETE those 2 rows from drizzle's journal → COMMIT only if the INSERT and the DELETE each touched exactly 2 rows, else ROLLBACK.
// Blueprint's own rows are never touched. Never prints the URL, a host, a user or an error message.
import { CAW_CREATED_AT, type Client, openClient, readState } from "./db-inspect";

export type FixResult =
  | { ok: true; moved: number; cawJournal: number; drizzleJournal: number }
  | { ok: false; reason: string };

export async function fixJournal(client: Client): Promise<FixResult> {
  const stamps = CAW_CREATED_AT.join(", ");
  await client.exec("BEGIN");
  try {
    const state = await readState(client.exec); // the guard is read inside the same transaction as the writes
    if (state.verdict !== "CASE A") {
      await client.exec("ROLLBACK");
      return { ok: false, reason: `refused — the verdict is ${state.verdict}, not CASE A; nothing was written (run db:inspect)` };
    }
    await client.exec(`CREATE TABLE IF NOT EXISTS caw.__caw_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    const inserted = Number((await client.exec(
      `WITH moved AS (INSERT INTO caw.__caw_migrations (hash, created_at) SELECT hash, created_at FROM drizzle.__drizzle_migrations WHERE created_at IN (${stamps}) ORDER BY created_at RETURNING 1) SELECT count(*)::int AS n FROM moved`))[0]!.n);
    const deleted = Number((await client.exec(
      `WITH gone AS (DELETE FROM drizzle.__drizzle_migrations WHERE created_at IN (${stamps}) RETURNING 1) SELECT count(*)::int AS n FROM gone`))[0]!.n);
    if (inserted !== 2 || deleted !== 2) {
      await client.exec("ROLLBACK");
      return { ok: false, reason: `rolled back — the INSERT touched ${inserted} rows and the DELETE ${deleted}, expected 2 and 2; nothing was written` };
    }
    const after = {
      cawJournal: Number((await client.exec(`SELECT count(*)::int AS n FROM caw.__caw_migrations`))[0]!.n),
      drizzleJournal: Number((await client.exec(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`))[0]!.n),
    };
    await client.exec("COMMIT");
    return { ok: true, moved: inserted, ...after };
  } catch (e) {
    await client.exec("ROLLBACK").catch(() => {});
    throw e;
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL ?? "";
  let client: Client | undefined;
  try {
    if (!url) throw Object.assign(new Error(), { code: "no DATABASE_URL" });
    client = await openClient(url);
    const r = await fixJournal(client);
    if (r.ok) {
      console.log(`moved ${r.moved} journal rows`);
      console.log(`caw.__caw_migrations = ${r.cawJournal} · drizzle.__drizzle_migrations = ${r.drizzleJournal}`);
      console.log("next: bun run db:migrate → migrations applied (nothing left to apply)");
    } else {
      console.log(r.reason);
      process.exitCode = 1;
    }
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    console.log(`db:fix-journal failed — code ${e.code ?? e.cause?.code ?? "none"}`);
    process.exitCode = 1;
  } finally {
    await client?.close().catch(() => {});
  }
}
