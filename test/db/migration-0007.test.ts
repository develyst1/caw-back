// Migration 0007 (contract v1.12, D-068): caw.workers.avatar, jsonb, nullable, no default. It must apply on a database already at 0006
// (what SIT will be) and leave every worker with avatar NULL ("not chosen" — the screen derives a face), and take a value afterwards.
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

test("0007 applies on a database at 0006: workers.avatar is jsonb, nullable, no default; an old worker has avatar NULL; the column takes a value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-mig7-"));
  const pg = new PGlite();
  try {
    const src = MIGRATIONS.migrationsFolder;
    cpSync(src, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(8);
    expect(journal.entries[7]!.tag).toMatch(/^0007_/);
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 7) }));
    await migrate(drizzle({ client: pg }), { ...MIGRATIONS, migrationsFolder: dir });
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(7);
    await pg.exec(`INSERT INTO caw.workers (id, name, roles, skills, model, effort, created_at) VALUES ('${U(1)}','old-be','{BE}','{s}','sonnet','medium', now()),
      ('${U(2)}','old-combined','{other}','{s}','opus','high', now())`);
    expect(await rows(pg, "select column_name from information_schema.columns where table_schema='caw' and table_name='workers' and column_name='avatar'")).toEqual([]);

    await migrate(drizzle({ client: pg }), MIGRATIONS);
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(journal.entries.length);
    expect(await rows(pg, "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='caw' and table_name='workers' and column_name='avatar'"))
      .toEqual([{ column_name: "avatar", data_type: "jsonb", is_nullable: "YES", column_default: null }]);
    expect(await rows(pg, "select name, avatar from caw.workers order by name")).toEqual([{ name: "old-be", avatar: null }, { name: "old-combined", avatar: null }]);
    expect(await rows(pg, "select name, roles from caw.workers order by name")).toEqual([{ name: "old-be", roles: ["BE"] }, { name: "old-combined", roles: ["other"] }]); // nothing else moved
    await pg.exec(`UPDATE caw.workers SET avatar = '{"body":"round","color":"teal","eyes":"dots"}' WHERE id = '${U(1)}'`);
    expect(await rows(pg, `select avatar from caw.workers where id = '${U(1)}'`)).toEqual([{ avatar: { body: "round", color: "teal", eyes: "dots" } }]);
    await pg.exec(`INSERT INTO caw.workers (id, name, roles, skills, model, effort, created_at) VALUES ('${U(3)}','new','{PM}','{s}','opus','medium', now())`); // an insert that leaves it out stores NULL
    expect(await rows(pg, `select avatar from caw.workers where id = '${U(3)}'`)).toEqual([{ avatar: null }]);
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
