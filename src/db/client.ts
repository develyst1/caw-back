import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const migrationsFolder = new URL("./migrations", import.meta.url).pathname;

// `pglite:memory` → an in-memory PGlite with every migration applied. `pglite:file:<dir>` → the same, kept in a directory
// (a local check that stops and restarts caw-back and still finds its data). Anything else is a Postgres URL; the operator
// migrates a real database himself (`bun run db:migrate`).
const FILE = "pglite:file:";
export async function createDb(url: string): Promise<Db> {
  if (url === "pglite:memory" || url.startsWith(FILE)) {
    const db = drizzlePglite({ client: new PGlite(url === "pglite:memory" ? undefined : url.slice(FILE.length)), schema });
    await migrate(db, { migrationsFolder });
    return db;
  }
  return drizzlePostgres({ client: postgres(url), schema });
}
