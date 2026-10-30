// Migration 0012 (REQ-105 D12, TASK-115): `cards.anchor_removed_revision`, nullable, no default. It must apply on a database at 0011 that already has cards, leave them
// readable with NULL (= the anchor part is in the spec), and accept a revision.
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

test("0012 applies on a database at 0011 with a card in it: the card keeps its values and reads anchor_removed_revision NULL; a revision can be stored and cleared; the column is nullable with no default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-mig12-"));
  const pg = new PGlite();
  try {
    const src = MIGRATIONS.migrationsFolder;
    cpSync(src, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries[12]!.tag).toBe("0012_card_anchor_removed");
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 12) }));
    await migrate(drizzle({ client: pg }), { ...MIGRATIONS, migrationsFolder: dir });
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(12);
    expect(await rows(pg, "select 1 from information_schema.columns where table_schema='caw' and table_name='cards' and column_name='anchor_removed_revision'")).toHaveLength(0);

    await pg.exec(`INSERT INTO caw.projects (id, name, blueprint_project_id, version, latest_seen_version, created_at) VALUES ('${U(2)}','p','bp',1,1, now())`);
    await pg.exec(`INSERT INTO caw.cards (id, project_id, number, kind, title, todo, status, anchor_key, anchor_version, anchor_revision, created_at, updated_at) VALUES ('${U(5)}','${U(2)}',1,'work','t','x','todo','STEP-004',1,4, now(), now())`);

    await migrate(drizzle({ client: pg }), MIGRATIONS);
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(journal.entries.length);
    expect(await rows(pg, "select anchor_key, anchor_revision, anchor_removed_revision from caw.cards")).toEqual([{ anchor_key: "STEP-004", anchor_revision: 4, anchor_removed_revision: null }]);
    expect(await rows(pg, "select is_nullable, column_default from information_schema.columns where table_schema='caw' and table_name='cards' and column_name='anchor_removed_revision'")).toEqual([{ is_nullable: "YES", column_default: null }]);

    await pg.exec(`UPDATE caw.cards SET anchor_removed_revision = 7`);
    expect(await rows(pg, "select anchor_removed_revision from caw.cards")).toEqual([{ anchor_removed_revision: 7 }]);
    await pg.exec(`UPDATE caw.cards SET anchor_removed_revision = NULL`);
    expect(await rows(pg, "select anchor_removed_revision from caw.cards")).toEqual([{ anchor_removed_revision: null }]);
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
