// REWORK R1 (TASK-A-071 review): CAW and Blueprint share ONE database (`blueprint`). drizzle's default journal is
// `drizzle.__drizzle_migrations` — Blueprint's own — and it applies only migrations newer than the last row it finds, so two
// apps writing one journal would make each skip the other's next migration. CAW keeps its journal in its own schema.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { MIGRATIONS } from "../../src/db/migrations-config";
import { testDb } from "../helpers/db";

const rowsOf = async <T>(db: Awaited<ReturnType<typeof testDb>>, q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;

test("after migrate: the journal is caw.__caw_migrations (2 rows); schema `drizzle` and `public` hold nothing of ours", async () => {
  const db = await testDb();
  const tables = await rowsOf<{ table_schema: string; table_name: string }>(db, sql`select table_schema, table_name from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by 1, 2`);
  const bySchema = (s: string) => tables.filter((t) => t.table_schema === s).map((t) => t.table_name);
  expect(bySchema("drizzle")).toEqual([]); // no drizzle.__drizzle_migrations — that name is Blueprint's
  expect(bySchema("public")).toEqual([]);
  expect(bySchema("caw")).toContain("__caw_migrations");
  expect(Object.keys(tables.reduce((m, t) => ({ ...m, [t.table_schema]: 1 }), {}))).toEqual(["caw"]); // nothing outside `caw`
  expect(await rowsOf(db, sql`select 1 from caw.__caw_migrations`)).toHaveLength(2);
});

test("the journal's name lives in one place, and both migrate call sites (the app's PGlite and `bun run db:migrate`) use it", () => {
  expect(MIGRATIONS).toMatchObject({ migrationsSchema: "caw", migrationsTable: "__caw_migrations" });
  for (const file of ["../../src/db/client.ts", "../../src/scripts/migrate.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    expect([file, /\bmigrate\([^\n]*,\s*MIGRATIONS\)/.test(src)]).toEqual([file, true]);
  }
});
