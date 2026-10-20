// Migration 0009 (contract v1.16, REQ-015 R2a): caw.projects.code_map, jsonb, nullable, no default. It must apply on a database at 0008 (what SIT will be),
// leave every project with code_map NULL ("no code map yet"), and take a value afterwards. (workspace.readOnly needs no migration: workspace is jsonb.)
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

test("0009 applies on a database at 0008: projects.code_map is jsonb, nullable, no default; an old project has code_map NULL and its workspace untouched; the column takes a value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-mig9-"));
  const pg = new PGlite();
  try {
    const src = MIGRATIONS.migrationsFolder;
    cpSync(src, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(10);
    expect(journal.entries[9]!.tag).toMatch(/^0009_/);
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 9) }));
    await migrate(drizzle({ client: pg }), { ...MIGRATIONS, migrationsFolder: dir });
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(9);
    await pg.exec(`INSERT INTO caw.projects (id, name, blueprint_project_id, version, latest_seen_version, workspace, created_at) VALUES ('${U(2)}','p','bp',1,1,'{"roots":["/a/b"]}', now())`);
    expect(await rows(pg, "select column_name from information_schema.columns where table_schema='caw' and table_name='projects' and column_name='code_map'")).toEqual([]);

    await migrate(drizzle({ client: pg }), MIGRATIONS);
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(journal.entries.length);
    expect(await rows(pg, "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='caw' and table_name='projects' and column_name='code_map'"))
      .toEqual([{ column_name: "code_map", data_type: "jsonb", is_nullable: "YES", column_default: null }]);
    expect(await rows(pg, "select code_map, workspace from caw.projects")).toEqual([{ code_map: null, workspace: { roots: ["/a/b"] } }]);
    await pg.exec(`UPDATE caw.projects SET code_map = '{"folders":[{"name":"a","kind":"fe"}]}' WHERE id = '${U(2)}'`);
    expect(await rows(pg, `select code_map from caw.projects where id = '${U(2)}'`)).toEqual([{ code_map: { folders: [{ name: "a", kind: "fe" }] } }]);
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
