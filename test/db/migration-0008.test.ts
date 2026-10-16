// Migration 0008 (contract v1.14, D-081 ask 1): caw.workers.deleted_at, and the name's uniqueness moves from a table constraint to a unique
// index over the LIVE rows only (a deleted worker's name is free again). It must apply on a database at 0007 (what SIT will be).
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS } from "../../src/db/migrations-config";

const rows = async (pg: PGlite, q: string) => (await pg.query(q)).rows as any[];
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const worker = (id: number, name: string, deleted = false) =>
  `INSERT INTO caw.workers (id, name, roles, skills, model, effort, created_at${deleted ? ", deleted_at" : ""}) VALUES ('${U(id)}','${name}','{BE}','{s}','sonnet','medium', now()${deleted ? ", now()" : ""})`;

test("0008 applies on a database at 0007: deleted_at NULL for the old workers, workers_name_unique gone, workers_name_live exists; a deleted twin of a live name is accepted, two live ones are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-mig8-"));
  const pg = new PGlite();
  try {
    const src = MIGRATIONS.migrationsFolder;
    cpSync(src, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(9);
    expect(journal.entries[8]!.tag).toMatch(/^0008_/);
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 8) }));
    await migrate(drizzle({ client: pg }), { ...MIGRATIONS, migrationsFolder: dir });
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(8);
    await pg.exec(`${worker(1, "Ann")}; ${worker(2, "Ben")}`);
    expect(await rows(pg, "select conname from pg_constraint where conrelid = 'caw.workers'::regclass and conname = 'workers_name_unique'")).toEqual([{ conname: "workers_name_unique" }]);
    expect(await rows(pg, "select column_name from information_schema.columns where table_schema='caw' and table_name='workers' and column_name='deleted_at'")).toEqual([]);

    await migrate(drizzle({ client: pg }), MIGRATIONS);
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(journal.entries.length);
    expect(await rows(pg, "select column_name, data_type, is_nullable from information_schema.columns where table_schema='caw' and table_name='workers' and column_name='deleted_at'"))
      .toEqual([{ column_name: "deleted_at", data_type: "timestamp with time zone", is_nullable: "YES" }]);
    expect(await rows(pg, "select name, deleted_at from caw.workers order by name")).toEqual([{ name: "Ann", deleted_at: null }, { name: "Ben", deleted_at: null }]); // every old worker stays live
    expect(await rows(pg, "select conname from pg_constraint where conrelid = 'caw.workers'::regclass and conname = 'workers_name_unique'")).toEqual([]);
    expect(await rows(pg, "select indexname, indexdef from pg_indexes where schemaname='caw' and tablename='workers' and indexname='workers_name_live'")).toEqual([
      { indexname: "workers_name_live", indexdef: expect.stringMatching(/UNIQUE INDEX workers_name_live ON caw\.workers.*\(name\).*WHERE \(?deleted_at IS NULL\)?/i) },
    ]);

    await pg.exec(worker(3, "Cat", true)); // a deleted Cat …
    await pg.exec(worker(4, "Cat")); // … and a live Cat: accepted
    await pg.exec(worker(5, "Cat", true)); // a second deleted Cat: accepted too
    await expect(pg.exec(worker(6, "Cat"))).rejects.toThrow(); // two LIVE Cats: refused
    await expect(pg.exec(worker(7, "Ann"))).rejects.toThrow(); // an old live name is still unique
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
