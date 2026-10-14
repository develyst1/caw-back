// Migration 0002 (contract v1.3): `notes.allowed` and a widened `type` check. It must apply on a fresh database AND on one that is
// already at 0001 (what SIT is: the journal then has 2 rows and gets a 3rd) — and leave what is there alone.
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS } from "../../src/db/migrations-config";

const JOURNAL_ENTRIES = (JSON.parse(readFileSync(new URL("../../src/db/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: unknown[] }).entries.length;
const rows = async (pg: PGlite, q: string) => (await pg.query(q)).rows as any[];

test("0002 applies on a database already at 0001: a 3rd journal row, notes.allowed (uuid[], nullable), `handoff_refused` allowed in notes.type (later migrations then follow)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-mig-"));
  const pg = new PGlite();
  try {
    // a copy of the migrations folder holding only 0000 and 0001 — what the operator's SIT has applied
    const src = MIGRATIONS.migrationsFolder;
    cpSync(src, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as { entries: { idx: number }[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(3);
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }));
    await migrate(drizzle({ client: pg }), { ...MIGRATIONS, migrationsFolder: dir });
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(2);
    expect(await rows(pg, "select column_name from information_schema.columns where table_schema='caw' and table_name='notes' and column_name='allowed'")).toEqual([]);
    // some data at 0001: a project, a worker, a card and a note
    await pg.exec(`INSERT INTO caw.workers (id, name, role, skills, model, effort, created_at) VALUES ('00000000-0000-4000-8000-000000000001','w','BE','{s}','sonnet','medium', now());
      INSERT INTO caw.projects (id, name, blueprint_project_id, version, latest_seen_version, created_at) VALUES ('00000000-0000-4000-8000-000000000002','p','bp',1,1, now());
      INSERT INTO caw.cards (id, project_id, number, kind, title, todo, status, anchor_key, anchor_version, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002',1,'work','c','','todo','STEP-001',1, now(), now());
      INSERT INTO caw.notes (id, card_id, type, actor, text, at) VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','comment','operator','เก่า', now())`);

    await migrate(drizzle({ client: pg }), MIGRATIONS); // the real folder: only 0002 is pending
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(JOURNAL_ENTRIES);
    const col = await rows(pg, "select data_type, is_nullable from information_schema.columns where table_schema='caw' and table_name='notes' and column_name='allowed'");
    expect(col).toEqual([{ data_type: "ARRAY", is_nullable: "YES" }]);
    expect(await rows(pg, "select allowed, text from caw.notes")).toEqual([{ allowed: null, text: "เก่า" }]); // the old note is untouched
    await pg.exec(`INSERT INTO caw.notes (id, card_id, type, actor, text, at, allowed) VALUES ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000003','handoff_refused','operator','x', now(), '{00000000-0000-4000-8000-000000000001}')`);
    await expect(pg.exec(`INSERT INTO caw.notes (id, card_id, type, actor, text, at) VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000003','nonsense','operator','x', now())`)).rejects.toThrow(); // the check still refuses other types
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second run applies nothing (idempotent), and a fresh database gets every migration", async () => {
  const pg = new PGlite();
  try {
    await migrate(drizzle({ client: pg }), MIGRATIONS);
    await migrate(drizzle({ client: pg }), MIGRATIONS);
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(JOURNAL_ENTRIES);
  } finally {
    await pg.close();
  }
});
