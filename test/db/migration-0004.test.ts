// Migration 0004 (contract v1.9, D-057): chat_messages.retry_requested_at, nullable. It must apply on a database already at 0003
// (what SIT will be) and leave an existing message alone (retry_requested_at null).
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

test("0004 applies on a database at 0003: chat_messages gets a nullable retry_requested_at (timestamptz), an old message keeps null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-mig4-"));
  const pg = new PGlite();
  try {
    const src = MIGRATIONS.migrationsFolder;
    cpSync(src, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(5);
    expect(journal.entries[4]!.tag).toMatch(/^0004_/);
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 4) }));
    await migrate(drizzle({ client: pg }), { ...MIGRATIONS, migrationsFolder: dir });
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(4);
    expect(await rows(pg, "select column_name from information_schema.columns where table_schema='caw' and table_name='chat_messages' and column_name='retry_requested_at'")).toEqual([]);
    await pg.exec(`INSERT INTO caw.projects (id, name, blueprint_project_id, version, latest_seen_version, created_at) VALUES ('${U(2)}','p','bp',1,1, now());
      INSERT INTO caw.chat_messages (id, project_id, author, text, at) VALUES ('${U(5)}','${U(2)}','operator','สวัสดี', now())`);

    await migrate(drizzle({ client: pg }), MIGRATIONS);
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(journal.entries.length);
    expect(await rows(pg, "select column_name, is_nullable, data_type from information_schema.columns where table_schema='caw' and table_name='chat_messages' and column_name='retry_requested_at'"))
      .toEqual([{ column_name: "retry_requested_at", is_nullable: "YES", data_type: "timestamp with time zone" }]);
    expect(await rows(pg, "select id, retry_requested_at from caw.chat_messages")).toEqual([{ id: U(5), retry_requested_at: null }]);
    await pg.exec(`UPDATE caw.chat_messages SET retry_requested_at = now() WHERE id = '${U(5)}'`); // and it takes a value
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
