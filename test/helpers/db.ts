import { sql } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client";

// ONE migrated PGlite for the whole test run, emptied before each test. A PGlite per test (a WASM Postgres + two migrations,
// never closed) took 4.5 GB of memory over 77 tests — on a busy machine that swaps and single tests took minutes (TASK-A-071 R2).
// TRUNCATE does not fire the row triggers (the append-only rule on `events`) and leaves the migrations journal alone.
const TABLES = ["events", "follow_state", "hops", "runs", "notes", "card_deps", "cards", "chain_edges", "chain_members", "projects", "workers"];
let shared: Promise<Db> | undefined;

export async function testDb(): Promise<Db> {
  shared ??= createDb("pglite:memory");
  const db = await shared;
  await db.execute(sql.raw(`truncate ${TABLES.map((t) => `caw.${t}`).join(", ")} restart identity cascade`));
  return db;
}
