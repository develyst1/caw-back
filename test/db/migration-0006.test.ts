// Migration 0006 (contract v1.11, D-066): caw.hops.last_activity_at, NOT NULL. It must apply on a database already at 0005 (what SIT will
// be) and give every existing hop its own start time.
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

test("0006 applies on a database at 0005: every old hop (a finished card hop, a running one, a chat hop) gets last_activity_at = started_at; the column is NOT NULL timestamptz", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-mig6-"));
  const pg = new PGlite();
  try {
    const src = MIGRATIONS.migrationsFolder;
    cpSync(src, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(7);
    expect(journal.entries[6]!.tag).toMatch(/^0006_/);
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 6) }));
    await migrate(drizzle({ client: pg }), { ...MIGRATIONS, migrationsFolder: dir });
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(6);
    await pg.exec(`INSERT INTO caw.workers (id, name, roles, skills, model, effort, created_at) VALUES ('${U(1)}','w','{BE}','{s}','sonnet','medium', now());
      INSERT INTO caw.projects (id, name, blueprint_project_id, version, latest_seen_version, created_at) VALUES ('${U(2)}','p','bp',1,1, now());
      INSERT INTO caw.cards (id, project_id, number, kind, title, todo, status, anchor_key, anchor_version, created_at, updated_at) VALUES ('${U(3)}','${U(2)}',1,'work','c','','todo','STEP-001',1, now(), now());
      INSERT INTO caw.hops (id, project_id, card_id, worker_id, started_at, ended_at, outcome) VALUES ('${U(4)}','${U(2)}','${U(3)}','${U(1)}','2026-10-01T10:00:00Z','2026-10-01T10:05:00Z','commented');
      INSERT INTO caw.hops (id, project_id, card_id, worker_id, started_at) VALUES ('${U(5)}','${U(2)}','${U(3)}','${U(1)}','2026-10-02T09:30:00Z');
      INSERT INTO caw.chat_messages (id, project_id, author, text, at) VALUES ('${U(8)}','${U(2)}','operator','สวัสดี','2026-10-03T08:00:00Z');
      INSERT INTO caw.hops (id, project_id, message_id, worker_id, started_at, ended_at, outcome, located_keys) VALUES ('${U(9)}','${U(2)}','${U(8)}','${U(1)}','2026-10-03T08:01:00Z','2026-10-03T08:02:00Z','replied','{STEP-001}')`);
    expect(await rows(pg, "select column_name from information_schema.columns where table_schema='caw' and table_name='hops' and column_name='last_activity_at'")).toEqual([]);

    await migrate(drizzle({ client: pg }), MIGRATIONS);
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(journal.entries.length);
    expect(await rows(pg, "select column_name, is_nullable, data_type from information_schema.columns where table_schema='caw' and table_name='hops' and column_name='last_activity_at'"))
      .toEqual([{ column_name: "last_activity_at", is_nullable: "NO", data_type: "timestamp with time zone" }]);
    expect(await rows(pg, "select id, last_activity_at = started_at as same, last_activity_at is not null as filled from caw.hops order by id")).toEqual([
      { id: U(4), same: true, filled: true }, { id: U(5), same: true, filled: true }, { id: U(9), same: true, filled: true },
    ]); // a finished card hop, a RUNNING one (ended_at null) and a chat hop — each is given its own start time
    await expect(pg.exec(`INSERT INTO caw.hops (id, project_id, card_id, worker_id, started_at) VALUES ('${U(6)}','${U(2)}','${U(3)}','${U(1)}', now())`)).rejects.toThrow(); // NOT NULL
    await pg.exec(`INSERT INTO caw.hops (id, project_id, card_id, worker_id, started_at, last_activity_at) VALUES ('${U(7)}','${U(2)}','${U(3)}','${U(1)}', now(), now())`);
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
