// Migration 0005 (contract v1.10, D-060): caw.workers.role (text) → roles (text[]), with a check of ≥ 1 role from the seven. It must apply on a
// database already at 0004 (what SIT will be) and keep every existing worker: roles = ARRAY[role].
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
const worker = (id: number, name: string, extra = "role", value = "'BE'") =>
  `INSERT INTO caw.workers (id, name, ${extra}, skills, model, effort, created_at) VALUES ('${U(id)}','${name}',${value},'{s}','sonnet','medium', now())`;

test("0005 applies on a database at 0004: roles = ARRAY[role] for every old worker (a combined one stays {other}), role is gone, roles is NOT NULL and checked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-mig5-"));
  const pg = new PGlite();
  try {
    const src = MIGRATIONS.migrationsFolder;
    cpSync(src, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(6);
    expect(journal.entries[5]!.tag).toMatch(/^0005_/);
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 5) }));
    await migrate(drizzle({ client: pg }), { ...MIGRATIONS, migrationsFolder: dir });
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(5);
    await pg.exec(`${worker(1, "old-be")}; ${worker(2, "old-combined", "role", "'other'")}; ${worker(3, "old-pm", "role", "'PM'")}`);
    expect(await rows(pg, "select column_name from information_schema.columns where table_schema='caw' and table_name='workers' and column_name='roles'")).toEqual([]);

    await migrate(drizzle({ client: pg }), MIGRATIONS);
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(journal.entries.length);
    expect(await rows(pg, "select name, roles from caw.workers order by name")).toEqual([
      { name: "old-be", roles: ["BE"] }, { name: "old-combined", roles: ["other"] }, { name: "old-pm", roles: ["PM"] },
    ]);
    expect(await rows(pg, "select column_name from information_schema.columns where table_schema='caw' and table_name='workers' and column_name='role'")).toEqual([]);
    expect(await rows(pg, "select column_name, is_nullable, data_type from information_schema.columns where table_schema='caw' and table_name='workers' and column_name='roles'"))
      .toEqual([{ column_name: "roles", is_nullable: "NO", data_type: "ARRAY" }]);
    expect(await rows(pg, "select conname from pg_constraint where conrelid = 'caw.workers'::regclass and contype = 'c' order by 1")).toEqual(
      expect.arrayContaining([{ conname: "workers_roles" }]),
    );
    expect((await rows(pg, "select conname from pg_constraint where conrelid = 'caw.workers'::regclass and conname = 'workers_role'"))).toEqual([]); // the old check is gone

    const ins = (id: number, roles: string) => pg.exec(worker(id, `new-${id}`, "roles", `'${roles}'`));
    await ins(10, "{PM,BA}"); // several roles, BA included
    await ins(11, "{other}");
    await expect(ins(12, "{}")).rejects.toThrow(); // none
    await expect(ins(13, "{XX}")).rejects.toThrow(); // outside the seven
    await expect(ins(14, "{PM,XX}")).rejects.toThrow();
    await expect(pg.exec(`INSERT INTO caw.workers (id, name, skills, model, effort, created_at) VALUES ('${U(15)}','no-roles','{s}','sonnet','medium', now())`)).rejects.toThrow(); // NOT NULL
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
