// Migration 0003 (contract v1.4, REQ-013): chat_messages, proposals, hops.message_id + hops.located_keys, hops.card_id nullable with an
// exactly-one-of check, four new hop outcomes. It must apply on a database already at 0002 (what SIT will be) and leave a hop alone.
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

test("0003 applies on a database at 0002: new tables and columns, card_id nullable, exactly one of card_id / message_id, the four outcomes — an old hop is untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-mig3-"));
  const pg = new PGlite();
  try {
    const src = MIGRATIONS.migrationsFolder;
    cpSync(src, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as { entries: { idx: number }[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(4);
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 3) }));
    await migrate(drizzle({ client: pg }), { ...MIGRATIONS, migrationsFolder: dir });
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(3);
    expect(await rows(pg, "select table_name from information_schema.tables where table_schema='caw' and table_name in ('chat_messages','proposals')")).toEqual([]);
    // a card hop as it exists today
    await pg.exec(`INSERT INTO caw.workers (id, name, role, skills, model, effort, created_at) VALUES ('${U(1)}','w','BE','{s}','sonnet','medium', now());
      INSERT INTO caw.projects (id, name, blueprint_project_id, version, latest_seen_version, created_at) VALUES ('${U(2)}','p','bp',1,1, now());
      INSERT INTO caw.cards (id, project_id, number, kind, title, todo, status, anchor_key, anchor_version, created_at, updated_at) VALUES ('${U(3)}','${U(2)}',1,'work','c','','todo','STEP-001',1, now(), now());
      INSERT INTO caw.hops (id, project_id, card_id, worker_id, started_at, ended_at, outcome) VALUES ('${U(4)}','${U(2)}','${U(3)}','${U(1)}', now(), now(), 'commented')`);

    await migrate(drizzle({ client: pg }), MIGRATIONS);
    expect(await rows(pg, "select 1 from caw.__caw_migrations")).toHaveLength(journal.entries.length);
    expect((await rows(pg, "select table_name from information_schema.tables where table_schema='caw' and table_name in ('chat_messages','proposals') order by 1")).map((r) => r.table_name)).toEqual(["chat_messages", "proposals"]);
    const cols = await rows(pg, "select column_name, is_nullable from information_schema.columns where table_schema='caw' and table_name='hops' and column_name in ('card_id','message_id','located_keys') order by 1");
    expect(cols).toEqual([{ column_name: "card_id", is_nullable: "YES" }, { column_name: "located_keys", is_nullable: "YES" }, { column_name: "message_id", is_nullable: "YES" }]);
    expect(await rows(pg, "select card_id, message_id, located_keys, outcome from caw.hops")).toEqual([{ card_id: U(3), message_id: null, located_keys: null, outcome: "commented" }]);

    await pg.exec(`INSERT INTO caw.chat_messages (id, project_id, author, text, at) VALUES ('${U(5)}','${U(2)}','operator','สวัสดี', now())`);
    // a chat hop: message_id set, card_id null — with each of the new outcomes
    for (const [i, outcome] of ["replied", "proposed", "amended", "proposed_and_amended"].entries()) {
      await pg.exec(`INSERT INTO caw.hops (id, project_id, message_id, worker_id, started_at, last_activity_at, ended_at, outcome, located_keys) VALUES ('${U(10 + i)}','${U(2)}','${U(5)}','${U(1)}', now(), now(), now(), '${outcome}', '{STEP-001}')`);
    }
    await expect(pg.exec(`INSERT INTO caw.hops (id, project_id, worker_id, started_at, last_activity_at) VALUES ('${U(20)}','${U(2)}','${U(1)}', now(), now())`)).rejects.toThrow(); // neither
    await expect(pg.exec(`INSERT INTO caw.hops (id, project_id, card_id, message_id, worker_id, started_at, last_activity_at) VALUES ('${U(21)}','${U(2)}','${U(3)}','${U(5)}','${U(1)}', now(), now())`)).rejects.toThrow(); // both
    await expect(pg.exec(`INSERT INTO caw.hops (id, project_id, message_id, worker_id, started_at, last_activity_at, outcome) VALUES ('${U(22)}','${U(2)}','${U(5)}','${U(1)}', now(), now(), 'nonsense')`)).rejects.toThrow(); // an outcome not in the list
    await pg.exec(`INSERT INTO caw.proposals (id, project_id, message_id, version, items, status) VALUES ('${U(30)}','${U(2)}','${U(5)}',1,'[]','open')`.replace(") VALUES", ", created_at) VALUES").replace("'open')", "'open', now())"));
    await expect(pg.exec(`INSERT INTO caw.proposals (id, project_id, message_id, version, items, status, created_at) VALUES ('${U(31)}','${U(2)}','${U(5)}',1,'[]','weird', now())`)).rejects.toThrow();
  } finally {
    await pg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
