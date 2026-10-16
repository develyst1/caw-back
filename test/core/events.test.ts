// The event store's core (SPEC-A-008 § Design, TASK-A-071): one write = one event + the tables it changes, in one
// transaction; the tables are what the reducer makes of the events; a rebuild from the events equals them (AC-6).
import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { events, projects } from "../../src/db/schema";
import { EVENT_TYPES, type CawEvent } from "../../src/core/events";
import { rebuild, rebuildCheck } from "../../src/core/rebuild";
import { empty, reduce } from "../../src/core/reduce";
import { writeEvent } from "../../src/core/write";
import { testDb } from "../helpers/db";

const ID = "11111111-1111-4111-8111-111111111111";
const created = (over: Partial<Extract<CawEvent, { type: "project.created" }>["data"]> = {}): CawEvent => ({
  type: "project.created", projectId: ID, actor: "operator", at: "2026-10-13T08:00:00.123Z",
  data: { id: ID, name: "จองห้องประชุม", blueprintProjectId: "bp-1", version: 1, ...over },
});

test("reduce is pure: project.created makes the project with its defaults; the input state is untouched", () => {
  const snapshot = structuredClone(empty);
  const after = reduce(empty, created());
  expect(empty).toEqual(snapshot);
  expect(after.project).toEqual({
    id: ID, name: "จองห้องประชุม", blueprintProjectId: "bp-1", version: 1, latestSeenVersion: 1,
    mode: "manual", hopBudget: 0, hopsUsed: 0, workspace: { roots: [] }, entryWorkerId: null, createdAt: "2026-10-13T08:00:00.123Z",
  });
  expect(() => reduce(after, created())).toThrow("project.created twice");
});

test("writeEvent: the event and the table row land together; the row equals what the reducer says", async () => {
  const db = await testDb();
  const { seq } = await writeEvent(db, created());
  const [ev] = await db.select().from(events);
  expect([ev!.seq, ev!.type, ev!.actor, ev!.projectId]).toEqual([seq, "project.created", "operator", ID]);
  const [row] = await db.select().from(projects);
  expect(row).toMatchObject({ id: ID, name: "จองห้องประชุม", blueprintProjectId: "bp-1", version: 1, latestSeenVersion: 1, mode: "manual", hopBudget: 0, hopsUsed: 0, entryWorkerId: null });
  expect(row!.createdAt.toISOString()).toBe("2026-10-13T08:00:00.123Z");
});

test("writeEvent is one transaction: a write the tables refuse leaves no event behind", async () => {
  const db = await testDb();
  await writeEvent(db, created());
  const other = "22222222-2222-4222-8222-222222222222";
  // same (blueprintProjectId, version) → the unique constraint refuses the row, after the event insert was attempted
  await expect(writeEvent(db, { ...created({ id: other }), projectId: other })).rejects.toThrow();
  expect(await db.select().from(events)).toHaveLength(1);
  expect(await db.select().from(projects)).toHaveLength(1);
});

test("events are append-only: the database refuses UPDATE and DELETE", async () => {
  const db = await testDb();
  await writeEvent(db, created());
  await expect((async () => { await db.update(events).set({ type: "x" }).where(eq(events.projectId, ID)); })()).rejects.toThrow();
  await expect((async () => { await db.delete(events).where(eq(events.projectId, ID)); })()).rejects.toThrow();
  expect(await db.select().from(events)).toHaveLength(1);
});

test("rebuild: replaying the project's events from empty gives the state the tables hold (AC-6)", async () => {
  const db = await testDb();
  await writeEvent(db, created());
  expect((await rebuild(db, ID)).project).toMatchObject({ id: ID, name: "จองห้องประชุม", latestSeenVersion: 1 });
  expect(await rebuildCheck(db, ID)).toEqual({ same: true });
});

test("rebuild-check says what differs when a table was changed behind the events' back", async () => {
  const db = await testDb();
  await writeEvent(db, created());
  await db.execute(sql`update caw.projects set hops_used = 7 where id = ${ID}`);
  const res = await rebuildCheck(db, ID);
  expect(res.same).toBe(false);
  expect(res.diff).toMatchObject({ tables: { project: { hopsUsed: 7 } }, rebuilt: { project: { hopsUsed: 0 } } });
});

test("a worker-only event (projectId null) is replayed for every project: rebuild reads events of the project and the null ones, in seq order", async () => {
  const db = await testDb();
  await writeEvent(db, created());
  await db.insert(events).values({ projectId: null, type: "worker.created", actor: "operator", at: new Date(), data: {} });
  const seen: string[] = [];
  await rebuild(db, ID, (e) => seen.push(e.type));
  expect(seen).toEqual(["project.created", "worker.created"]);
});

test("the event vocabulary is SPEC-A-008 § Event types, v1.1 included — 37 names (v1.3 added card.handoff_refused; v1.4 the chat, hop.located and proposal events; v1.9 chat.retry_requested; v1.10 worker.updated; v1.11 hop.heartbeat; v1.14 worker.deleted)", () => {
  expect([...EVENT_TYPES]).toEqual([
    "project.created", "worker.created", "worker.combined", "chain.member_added", "chain.member_removed", "chain.edge_added",
    "chain.edge_removed", "chain.entry_set", "card.created", "card.dependency_added", "card.status_set", "card.assigned",
    "card.handed_off", "card.commented", "card.question_opened", "card.question_answered", "card.spec_changed",
    "card.spec_change_cleared", "card.handoff_refused", "project.mode_set", "project.budget_set", "project.workspace_set", "run.started", "run.finished",
    "hop.claimed", "hop.started", "hop.finished", "chat.posted", "chat.replied", "hop.located", "proposal.made", "proposal.accepted", "proposal.superseded",
    "chat.retry_requested", "worker.updated", "hop.heartbeat", "worker.deleted",
  ]);
  expect(EVENT_TYPES).toHaveLength(37);
});
