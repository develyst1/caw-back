// Migration 0010 (REQ-104, SPEC-103 § Data Model): caw.hop_output — what a hop's CLI showed, one row per (hop_id, seq). It must apply on a database at 0009
// (what SIT will be) and leave the table empty; the primary key, the three checks and the foreign key to caw.hops must hold.
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
const refused = async (pg: PGlite, sql: string) => { try { await pg.exec(sql); return null; } catch (e) { return String((e as Error).message); } };

test("0010 applies on a database at 0009: hop_output is there, empty, with its columns, primary key, three checks and the foreign key to hops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-mig10-"));
  const pg = new PGlite();
  try {
    const src = MIGRATIONS.migrationsFolder;
    cpSync(src, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(11);
    expect(journal.entries[10]!.tag).toBe("0010_hop_output");
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 10) }));
    await migrate(drizzle({ client: pg }), { ...MIGRATIONS, migrationsFolder: dir });
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(10);
    expect(await rows(pg, "select 1 from information_schema.tables where table_schema='caw' and table_name='hop_output'")).toEqual([]);

    await migrate(drizzle({ client: pg }), MIGRATIONS);
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(journal.entries.length);
    expect(await rows(pg, "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='caw' and table_name='hop_output' order by ordinal_position")).toEqual([
      { column_name: "hop_id", data_type: "uuid", is_nullable: "NO", column_default: null },
      { column_name: "seq", data_type: "integer", is_nullable: "NO", column_default: null },
      { column_name: "at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: null },
      { column_name: "kind", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "text", data_type: "text", is_nullable: "NO", column_default: "''::text" },
      { column_name: "gap_seconds", data_type: "integer", is_nullable: "YES", column_default: null },
    ]);
    expect(await rows(pg, "select count(*)::int as n from caw.hop_output")).toEqual([{ n: 0 }]);
    expect(await rows(pg, "select conname, contype from pg_constraint where conrelid = 'caw.hop_output'::regclass and contype in ('c','f','p') order by conname")).toEqual([
      { conname: "hop_output_gap", contype: "c" },
      { conname: "hop_output_hop_id_hops_id_fk", contype: "f" },
      { conname: "hop_output_hop_id_seq_pk", contype: "p" },
      { conname: "hop_output_kind", contype: "c" },
      { conname: "hop_output_text_length", contype: "c" },
    ]);

    // a hop to hang rows on
    await pg.exec(`INSERT INTO caw.workers (id, name, roles, skills, model, effort, created_at) VALUES ('${U(1)}','w',ARRAY['BE'],ARRAY['s'],'sonnet','medium', now())`);
    await pg.exec(`INSERT INTO caw.projects (id, name, blueprint_project_id, version, latest_seen_version, created_at) VALUES ('${U(2)}','p','bp',1,1, now())`);
    await pg.exec(`INSERT INTO caw.chat_messages (id, project_id, author, text, at) VALUES ('${U(3)}','${U(2)}','operator','hi', now())`);
    await pg.exec(`INSERT INTO caw.hops (id, project_id, message_id, worker_id, started_at, last_activity_at) VALUES ('${U(4)}','${U(2)}','${U(3)}','${U(1)}', now(), now())`);
    const ins = (cols: string, vals: string) => `INSERT INTO caw.hop_output (hop_id, seq, at, ${cols}) VALUES ('${U(4)}', ${vals})`;

    await pg.exec(ins("kind, text", "0, now(), 'line', 'hello'"));
    await pg.exec(ins("kind, gap_seconds", "1, now(), 'gap', 30"));
    await pg.exec(ins("kind", "2, now(), 'truncated'"));
    expect(await rows(pg, "select seq, kind, text, gap_seconds from caw.hop_output order by seq")).toEqual([
      { seq: 0, kind: "line", text: "hello", gap_seconds: null },
      { seq: 1, kind: "gap", text: "", gap_seconds: 30 },
      { seq: 2, kind: "truncated", text: "", gap_seconds: null },
    ]);

    expect(await refused(pg, ins("kind, text", "0, now(), 'line', 'again'"))).toMatch(/hop_output_hop_id_seq_pk|duplicate key/); // primary key (hop_id, seq)
    expect(await refused(pg, ins("kind, text", "3, now(), 'banner', 'x'"))).toMatch(/hop_output_kind/);
    expect(await refused(pg, ins("kind, text", `3, now(), 'line', '${"x".repeat(2001)}'`))).toMatch(/hop_output_text_length/);
    expect(await refused(pg, ins("kind, text", `3, now(), 'line', '${"x".repeat(2000)}'`))).toBeNull(); // exactly 2000 is allowed
    expect(await refused(pg, ins("kind", "4, now(), 'gap'"))).toMatch(/hop_output_gap/); // a gap needs its seconds
    expect(await refused(pg, ins("kind, gap_seconds", "4, now(), 'line', 5"))).toMatch(/hop_output_gap/); // and only a gap has them
    expect(await refused(pg, `INSERT INTO caw.hop_output (hop_id, seq, at, kind) VALUES ('${U(99)}', 0, now(), 'truncated')`)).toMatch(/hop_output_hop_id_hops_id_fk|foreign key/); // no such hop
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
