// The test database is ONE PGlite for the whole run, emptied before each test (test/helpers/db.ts). That is only safe if
// "emptied" is true for every table and for the event sequence: a test must never see what an earlier one wrote.
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { writeEvent } from "../../src/core/write";
import { events, projects } from "../../src/db/schema";
import { testDb } from "../helpers/db";

const ID = "11111111-1111-4111-8111-111111111111";

test("testDb() hands every test an empty database (all caw tables, events' sequence from 1) — and it is the same instance", async () => {
  const first = await testDb();
  const ev = await writeEvent(first, { type: "project.created", projectId: ID, actor: "operator", at: "2026-10-13T08:00:00.000Z", data: { id: ID, name: "x", blueprintProjectId: "bp", version: 1 } });
  expect(ev.seq).toBe(1);
  expect(await first.select().from(projects)).toHaveLength(1);

  const second = await testDb();
  expect(second).toBe(first); // no new PGlite per test
  expect(await second.select().from(projects)).toHaveLength(0);
  expect(await second.select().from(events)).toHaveLength(0);
  const again = await writeEvent(second, { type: "project.created", projectId: ID, actor: "operator", at: "2026-10-13T08:00:00.000Z", data: { id: ID, name: "y", blueprintProjectId: "bp", version: 1 } });
  expect(again.seq).toBe(1); // identity restarted
  const counts = ((await second.execute(sql`select count(*)::int as n from caw.__caw_migrations`)) as unknown as { rows: { n: number }[] }).rows[0]!.n;
  expect(counts).toBe(2); // the migrations journal is not emptied
});
