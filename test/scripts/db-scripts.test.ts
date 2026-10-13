// TASK-A-076: the two scripts the operator runs on SIT for the 42P07 (studies/CAW-MIGRATE-42P07-2026-10-14.md):
// `db:inspect` (read-only: what is there, and a verdict) and `db:fix-journal` (Case A only: move CAW's two journal rows out of
// Blueprint's `drizzle.__drizzle_migrations` into `caw.__caw_migrations`). Every state is built by hand in a fresh PGlite — these
// tests, and I, never touch SIT (the repo's `.env` holds its URL; the child-process tests run from a temp dir so Bun cannot load it).
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS } from "../../src/db/migrations-config";
import { fixJournal } from "../../src/scripts/db-fix-journal";
import { inspect, render, type Client } from "../../src/scripts/db-inspect";

const MIG = new URL("../../src/db/migrations/", import.meta.url);
const CAW_ROWS = (JSON.parse(readFileSync(new URL("meta/_journal.json", MIG), "utf8")) as { entries: { tag: string; when: number }[] }).entries
  .map((e) => ({ created_at: e.when, hash: createHash("sha256").update(readFileSync(new URL(`${e.tag}.sql`, MIG), "utf8")).digest("hex") }));
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function raw() {
  const pg = new PGlite();
  await pg.waitReady;
  closers.push(() => pg.close());
  const log: string[] = [];
  const client: Client = { exec: async (text) => { log.push(text); return (await pg.query(text)).rows as Record<string, unknown>[]; }, close: async () => {} };
  const run = async (text: string) => (await pg.query(text)).rows as any[];
  return { pg, client, log, run };
}
/** the CAW tables, made from the real migration files, with NO journal */
async function cawTables(pg: PGlite) {
  for (const tag of ["0000_caw_schema", "0001_db_rules"]) {
    for (const stmt of readFileSync(new URL(`${tag}.sql`, MIG), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt);
  }
}
/** drizzle's shared journal (Blueprint's) with 6 Blueprint rows (+ the given extra rows) */
async function drizzleJournal(pg: PGlite, extra: { created_at: number; hash: string }[] = []) {
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
  for (let i = 0; i < 6; i++) await pg.query(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`, [`bp${i}`.padEnd(64, "0"), 1791400000000 + i * 1000]);
  for (const r of extra) await pg.query(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`, [r.hash, r.created_at]);
}
async function caseA() {
  const w = await raw();
  await cawTables(w.pg);
  await drizzleJournal(w.pg, CAW_ROWS); // the tables are there; their two journal rows went into Blueprint's journal
  return w;
}
const count = async (run: (t: string) => Promise<any[]>, table: string) => (await run(`select count(*)::int as n from ${table}`))[0].n as number;

test("CAW's two journal timestamps are the ones the study names", () => {
  expect(CAW_ROWS.map((r) => r.created_at)).toEqual([1791880568915, 1791880569138]);
});

test("db:inspect on Case A: the study's Step-1 facts and the verdict CASE A", async () => {
  const w = await caseA();
  const result = await inspect(w.client);
  expect(result.verdict).toBe("CASE A");
  const out = render(result).join("\n");
  expect(out).toContain("caw tables (11)");
  for (const t of ["card_deps", "cards", "chain_edges", "chain_members", "events", "follow_state", "hops", "notes", "projects", "runs", "workers"]) expect(out).toContain(t);
  expect(out).toContain("caw.__caw_migrations: absent");
  expect(out).toMatch(/events 0 · projects 0 · workers 0/);
  expect(out).toContain("drizzle.__drizzle_migrations: 8 rows");
  expect(out).toContain("1791880568915");
  expect(out).toContain(CAW_ROWS[1]!.hash.slice(0, 12));
  expect(out.trim().split("\n").at(-1)).toBe("verdict: CASE A");
});

test("db:inspect writes nothing: one READ ONLY transaction, rolled back, no write statement, nothing changed", async () => {
  const w = await caseA();
  const before = JSON.stringify([await w.run(`select table_schema, table_name from information_schema.tables where table_schema in ('caw','drizzle') order by 1,2`), await count(w.run, "drizzle.__drizzle_migrations")]);
  await inspect(w.client);
  expect(w.log[0]).toBe("BEGIN READ ONLY");
  expect(w.log.at(-1)).toBe("ROLLBACK");
  expect(w.log.filter((s) => /^\s*(insert|update|delete|create|drop|alter|truncate|grant)\b/i.test(s))).toEqual([]);
  const after = JSON.stringify([await w.run(`select table_schema, table_name from information_schema.tables where table_schema in ('caw','drizzle') order by 1,2`), await count(w.run, "drizzle.__drizzle_migrations")]);
  expect(after).toBe(before);
  // and the transaction really is read only: a write inside it is refused by the database
  await w.pg.exec("BEGIN READ ONLY");
  await expect(w.pg.exec(`CREATE TABLE caw.nope (x int)`)).rejects.toThrow();
  await w.pg.exec("ROLLBACK");
});

test("db:fix-journal on Case A: moves the 2 rows, leaves Blueprint's 6, and then the migrator applies nothing and succeeds", async () => {
  const w = await caseA();
  // before the fix the migrator tries to create the tables again — the 42P07 on SIT
  const failing = await migrate(drizzle({ client: w.pg }), MIGRATIONS).then(() => null, (e: any) => `${e?.message} ${e?.cause?.message ?? ""} ${e?.cause?.code ?? ""}`);
  expect(failing).toMatch(/already exists|42P07/);

  const res = await fixJournal(w.client);
  expect(res).toEqual({ ok: true, moved: 2, cawJournal: 2, drizzleJournal: 6 });
  expect((await w.run(`select created_at::text as c from caw.__caw_migrations order by created_at`)).map((r) => r.c)).toEqual(["1791880568915", "1791880569138"]);
  expect((await w.run(`select hash from caw.__caw_migrations order by created_at`)).map((r) => r.hash)).toEqual(CAW_ROWS.map((r) => r.hash));
  expect((await w.run(`select hash from drizzle.__drizzle_migrations order by created_at`)).map((r) => r.hash.slice(0, 2))).toEqual(["bp", "bp", "bp", "bp", "bp", "bp"]);

  await migrate(drizzle({ client: w.pg }), MIGRATIONS); // `db:migrate`'s migrator: nothing left to apply
  expect(await count(w.run, "caw.__caw_migrations")).toBe(2);
  expect(await count(w.run, "drizzle.__drizzle_migrations")).toBe(6);
  expect((await inspect(w.client)).verdict).toBe("MIGRATED");
  // a second fix refuses: there is nothing to fix any more
  expect((await fixJournal(w.client)).ok).toBe(false);
});

test("Case B (tables of unknown origin, no data, no CAW row anywhere): inspect says CASE B; the fix refuses and writes nothing", async () => {
  const w = await raw();
  await cawTables(w.pg);
  await drizzleJournal(w.pg);
  expect((await inspect(w.client)).verdict).toBe("CASE B");
  const res = await fixJournal(w.client);
  expect(res.ok).toBe(false);
  expect((res as { reason: string }).reason).toContain("CASE B");
  expect(await w.run(`select to_regclass('caw.__caw_migrations') as t`)).toEqual([{ t: null }]);
  expect(await count(w.run, "drizzle.__drizzle_migrations")).toBe(6);
});

test("Case C: data in caw.events, or CAW rows with other timestamps, or a duplicated row — inspect says CASE C; the fix refuses", async () => {
  const data = await caseA();
  await data.pg.exec(`INSERT INTO caw.events (type, actor, at, data) VALUES ('project.created', 'operator', now(), '{}')`);
  expect((await inspect(data.client)).verdict).toBe("CASE A"); // data does not change Case A: the rows are still Blueprint's journal's to give back
  const noRows = await raw();
  await cawTables(noRows.pg); await drizzleJournal(noRows.pg);
  await noRows.pg.exec(`INSERT INTO caw.events (type, actor, at, data) VALUES ('project.created', 'operator', now(), '{}')`);
  expect((await inspect(noRows.client)).verdict).toBe("CASE C"); // tables with data and no journal row anywhere: a human decides
  expect((await fixJournal(noRows.client)).ok).toBe(false);

  const other = await raw();
  await cawTables(other.pg);
  await drizzleJournal(other.pg, [{ created_at: 1791880568915, hash: "x".repeat(64) }, { created_at: 1791999999999, hash: "y".repeat(64) }]); // one of ours, one unknown
  expect((await inspect(other.client)).verdict).toBe("CASE C");
  expect((await fixJournal(other.client)).ok).toBe(false);
  expect(await count(other.run, "drizzle.__drizzle_migrations")).toBe(8);

  const dup = await raw();
  await cawTables(dup.pg);
  await drizzleJournal(dup.pg, [...CAW_ROWS, { created_at: CAW_ROWS[0]!.created_at, hash: "z".repeat(64) }]); // a third row with one of the timestamps
  expect((await inspect(dup.client)).verdict).toBe("CASE C");
  expect((await fixJournal(dup.client)).ok).toBe(false);
  expect(await count(dup.run, "drizzle.__drizzle_migrations")).toBe(9);
});

test("rows in BOTH journals (a half-done fix by hand) is CASE C — fixing it again would duplicate them", async () => {
  const w = await caseA();
  await w.pg.exec(`CREATE TABLE caw.__caw_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
  await w.pg.query(`INSERT INTO caw.__caw_migrations (hash, created_at) VALUES ($1, $2)`, [CAW_ROWS[0]!.hash, CAW_ROWS[0]!.created_at]);
  expect((await inspect(w.client)).verdict).toBe("CASE C");
  expect((await fixJournal(w.client)).ok).toBe(false);
  expect(await count(w.run, "caw.__caw_migrations")).toBe(1);
  expect(await count(w.run, "drizzle.__drizzle_migrations")).toBe(8);
});

test("CLEAN: no caw tables at all (with or without Blueprint's journal) — just run db:migrate; the fix refuses", async () => {
  const bare = await raw();
  expect((await inspect(bare.client)).verdict).toBe("CLEAN");
  expect(render(await inspect(bare.client)).join("\n")).toContain("caw tables: none");
  const withJournal = await raw();
  await drizzleJournal(withJournal.pg);
  expect((await inspect(withJournal.client)).verdict).toBe("CLEAN");
  expect((await fixJournal(withJournal.client)).ok).toBe(false);
});

test("MIGRATED (healthy): the journal is caw.__caw_migrations with both rows and drizzle's journal holds none of ours — never reported as CASE B", async () => {
  const w = await raw();
  await migrate(drizzle({ client: w.pg }), MIGRATIONS); // what `db:migrate` does on a clean database
  const result = await inspect(w.client);
  expect(result.verdict).toBe("MIGRATED");
  expect(render(result).join("\n")).toContain("drizzle.__drizzle_migrations: absent");
  expect((await fixJournal(w.client)).ok).toBe(false);
});

test("the fix is one transaction: an INSERT that fails, or that does not take exactly 2 rows, leaves both journals exactly as they were", async () => {
  // (a) the INSERT raises (a CHECK on the journal table nothing can satisfy): the error goes up, the transaction is rolled back
  const raises = await caseA();
  await raises.pg.exec(`CREATE TABLE caw.__caw_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint, CHECK (false))`);
  await expect(fixJournal(raises.client)).rejects.toBeDefined();
  expect(raises.log.at(-1)).toBe("ROLLBACK");
  expect(await count(raises.run, "drizzle.__drizzle_migrations")).toBe(8); // nothing deleted
  expect(await count(raises.run, "caw.__caw_migrations")).toBe(0); // nothing inserted

  // (b) the INSERT "succeeds" but takes 0 rows (a trigger swallows them): the count guard refuses and rolls back
  const short = await caseA();
  await short.pg.exec(`CREATE TABLE caw.__caw_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
    CREATE FUNCTION caw.swallow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER swallow BEFORE INSERT ON caw.__caw_migrations FOR EACH ROW EXECUTE FUNCTION caw.swallow()`);
  const res = await fixJournal(short.client);
  expect(res.ok).toBe(false);
  expect((res as { reason: string }).reason).toContain("expected 2 and 2");
  expect(short.log.at(-1)).toBe("ROLLBACK");
  expect(await count(short.run, "drizzle.__drizzle_migrations")).toBe(8);
  expect(await count(short.run, "caw.__caw_migrations")).toBe(0);
});

// The URL, a host, a user, an error message never reach the output. Run from a temp dir so Bun cannot load caw-back/.env (SIT).
test("failure output is one fixed line with the error code — no URL, host, user, password or message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-scripts-"));
  closers.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const script of ["db-inspect", "db-fix-journal"]) {
    const proc = Bun.spawn([process.execPath, "run", new URL(`../../src/scripts/${script}.ts`, import.meta.url).pathname], {
      cwd: dir, env: { ...(process.env as Record<string, string>), DATABASE_URL: "postgres://someuser:secretpw@127.0.0.1:1/blueprint" }, stdout: "pipe", stderr: "pipe",
    });
    const code = await proc.exited;
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    expect([script, code]).toEqual([script, 1]);
    expect(out).toContain(`${script.replace("db-", "db:")} failed — code `);
    for (const secret of ["secretpw", "someuser", "127.0.0.1", "postgres://", "blueprint"]) expect([script, out.includes(secret)]).toEqual([script, false]);
  }
});
