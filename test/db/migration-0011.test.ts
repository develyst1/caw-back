// Migration 0011 (REQ-105, SPEC-107 § Data Model): the latest label on the project, the label and revision on a card, the follow state's revision, and the two operational
// tables spec_parts / hop_spec. It must apply on a database at 0010 (what SIT will be) with rows already in it, leave those rows readable with the defaults, and the keys must hold.
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

test("0011 applies on a database at 0010 that already has a project, a card and a follow state: they keep their values and get the defaults; the two new tables are empty with their keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-mig11-"));
  const pg = new PGlite();
  try {
    const src = MIGRATIONS.migrationsFolder;
    cpSync(src, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(12);
    expect(journal.entries[11]!.tag).toBe("0011_spec_latest");
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 11) }));
    await migrate(drizzle({ client: pg }), { ...MIGRATIONS, migrationsFolder: dir });
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(11);

    // rows as SIT has them at 0010
    await pg.exec(`INSERT INTO caw.projects (id, name, blueprint_project_id, version, latest_seen_version, created_at) VALUES ('${U(2)}','p','bp',2,3, now())`);
    await pg.exec(`INSERT INTO caw.cards (id, project_id, number, kind, title, todo, status, anchor_key, anchor_version, created_at, updated_at) VALUES ('${U(5)}','${U(2)}',1,'work','t','x','todo','STEP-004',2, now(), now())`);
    await pg.exec(`INSERT INTO caw.follow_state (project_id, last_pulled_version) VALUES ('${U(2)}', 3)`);

    await migrate(drizzle({ client: pg }), MIGRATIONS);
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(journal.entries.length);

    // the old rows: their values kept, the new columns at their defaults
    expect(await rows(pg, "select version, latest_seen_version, latest_label from caw.projects")).toEqual([{ version: 2, latest_seen_version: 3, latest_label: null }]);
    expect(await rows(pg, "select anchor_key, anchor_version, anchor_label, anchor_revision from caw.cards")).toEqual([{ anchor_key: "STEP-004", anchor_version: 2, anchor_label: null, anchor_revision: 0 }]);
    expect(await rows(pg, "select last_pulled_version, last_pulled_revision, last_pull_ok from caw.follow_state")).toEqual([{ last_pulled_version: 3, last_pulled_revision: 0, last_pull_ok: true }]);

    const col = (t: string) => rows(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='caw' and table_name='${t}' order by ordinal_position`);
    expect(await col("spec_parts")).toEqual([
      { column_name: "project_id", data_type: "uuid", is_nullable: "NO", column_default: null },
      { column_name: "key", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "revision", data_type: "integer", is_nullable: "NO", column_default: null },
      { column_name: "body", data_type: "jsonb", is_nullable: "NO", column_default: null },
      { column_name: "read_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: null },
    ]);
    expect(await col("hop_spec")).toEqual([
      { column_name: "hop_id", data_type: "uuid", is_nullable: "NO", column_default: null },
      { column_name: "revision", data_type: "integer", is_nullable: "NO", column_default: null },
      { column_name: "body", data_type: "jsonb", is_nullable: "NO", column_default: null },
      { column_name: "read_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: null },
      { column_name: "from_cache", data_type: "boolean", is_nullable: "NO", column_default: null },
    ]);
    expect(await rows(pg, "select (select count(*)::int from caw.spec_parts) as parts, (select count(*)::int from caw.hop_spec) as hops")).toEqual([{ parts: 0, hops: 0 }]);
    expect(await rows(pg, "select conrelid::regclass::text as t, conname, contype from pg_constraint where conrelid in ('caw.spec_parts'::regclass, 'caw.hop_spec'::regclass) and contype in ('f','p') order by conname")).toEqual([
      { t: "caw.hop_spec", conname: "hop_spec_hop_id_hops_id_fk", contype: "f" },
      { t: "caw.hop_spec", conname: "hop_spec_pkey", contype: "p" },
      { t: "caw.spec_parts", conname: "spec_parts_project_id_key_pk", contype: "p" },
      { t: "caw.spec_parts", conname: "spec_parts_project_id_projects_id_fk", contype: "f" },
    ]);

    // spec_parts: one row per (project, key); the project must exist
    const part = (project: string, key: string) => `INSERT INTO caw.spec_parts (project_id, key, revision, body, read_at) VALUES ('${project}','${key}',1,'{"part":{"key":"${key}"}}', now())`;
    await pg.exec(part(U(2), "STEP-004"));
    expect(await refused(pg, part(U(2), "STEP-004"))).toMatch(/spec_parts_project_id_key_pk|duplicate key/);
    await pg.exec(part(U(2), "STEP-005"));
    expect(await refused(pg, part(U(99), "STEP-004"))).toMatch(/spec_parts_project_id_projects_id_fk|foreign key/);
    expect(await refused(pg, `INSERT INTO caw.spec_parts (project_id, key, revision, read_at) VALUES ('${U(2)}','X',1, now())`)).toMatch(/body|null value/); // the body is required

    // hop_spec: one row per hop; the hop must exist
    await pg.exec(`INSERT INTO caw.workers (id, name, roles, skills, model, effort, created_at) VALUES ('${U(1)}','w',ARRAY['BE'],ARRAY['s'],'sonnet','medium', now())`);
    await pg.exec(`INSERT INTO caw.hops (id, project_id, card_id, worker_id, started_at, last_activity_at) VALUES ('${U(4)}','${U(2)}','${U(5)}','${U(1)}', now(), now())`);
    const pin = (hop: string) => `INSERT INTO caw.hop_spec (hop_id, revision, body, read_at, from_cache) VALUES ('${hop}',1,'{"part":{"key":"STEP-004"}}', now(), false)`;
    await pg.exec(pin(U(4)));
    expect(await refused(pg, pin(U(4)))).toMatch(/hop_spec_pkey|duplicate key/);
    expect(await refused(pg, pin(U(98)))).toMatch(/hop_spec_hop_id_hops_id_fk|foreign key/);
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
