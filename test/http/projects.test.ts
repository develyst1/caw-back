// TASK-A-071: the project routes, the actor rule and "no spec content" — against a fake Blueprint serving RECORDED responses.
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { cards, events, workers } from "../../src/db/schema";
import { createProject, setup } from "../helpers/api";
import { writeEvent } from "../../src/core/write";
import { BP_NAME, BP_PROJECT, BP_PROJECT_2 } from "../helpers/fake-blueprint";

const create = createProject;

test("GET /health → { ok: true }", async () => {
  const { app } = await setup();
  const res = await app.request("/health");
  expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
});

test("the actor rule: a write needs X-CAW-Actor: operator | worker:<uuid> — missing / malformed → 400 actor_required", async () => {
  const { call } = await setup();
  for (const actor of [null, "", "someone", "worker:", "worker:not-a-uuid", "Operator", "operator,worker"]) {
    const r = await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT, version: 1 }, actor);
    expect([actor, r.status, r.json.error.code]).toEqual([actor, 400, "actor_required"]);
  }
});

test("an unknown worker id → 400 unknown_worker; a known worker writing a project → 403 operator_only; reads need no actor", async () => {
  const { call, db } = await setup();
  const ghost = "worker:33333333-3333-4333-8333-333333333333";
  const r1 = await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT, version: 1 }, ghost);
  expect([r1.status, r1.json.error.code]).toEqual([400, "unknown_worker"]);

  const id = "44444444-4444-4444-8444-444444444444";
  await db.insert(workers).values({ id, name: "w", roles: ["BE"], skills: ["x"], model: "sonnet", effort: "medium", createdAt: new Date() });
  const r2 = await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT, version: 1 }, `worker:${id}`);
  expect([r2.status, r2.json.error.code]).toEqual([403, "operator_only"]);

  expect((await call("GET", "/v1/projects", undefined, null)).status).toBe(200);
});

test("POST /v1/projects: 201 with the Project — ids and version only; the event records who and what", async () => {
  const { call, db, fake } = await setup();
  const r = await create(call);
  expect(r.status).toBe(201);
  expect(r.json).toMatchObject({
    name: BP_NAME, blueprintProjectId: BP_PROJECT, version: 1, latestSeenVersion: 1, mode: "manual", hopBudget: 0, hopsUsed: 0,
    entryWorkerId: null, workspace: { roots: [], readOnly: [] }, codeMap: null,
  });
  expect(Object.keys(r.json).sort()).toEqual(["blueprintProjectId", "codeMap", "createdAt", "entryWorkerId", "hopBudget", "hopsUsed", "id", "latestSeenVersion", "mode", "name", "version", "workspace"]);
  expect(fake.mode.calls).toEqual([`GET /v1/projects/${BP_PROJECT}`, `GET /v1/projects/${BP_PROJECT}/versions/1`]);
  const [ev] = await db.select().from(events);
  expect([ev!.type, ev!.actor, ev!.projectId]).toEqual(["project.created", "operator", r.json.id]);
  expect(ev!.data).toEqual({ id: r.json.id, name: BP_NAME, blueprintProjectId: BP_PROJECT, version: 1 });
});

test("POST /v1/projects errors: 400 body · 404 blueprint_project_not_found · 409 version_not_confirmed · 409 already_exists (with its id) · 502", async () => {
  const { call, fake } = await setup();
  expect((await call("POST", "/v1/projects", { blueprintProjectId: "", version: 1 })).status).toBe(400);
  expect((await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT, version: 0 })).status).toBe(400);
  expect((await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT })).status).toBe(400);

  const nf = await create(call, { blueprintProjectId: "00000000-0000-0000-0000-000000000099" });
  expect([nf.status, nf.json.error.code]).toEqual([404, "blueprint_project_not_found"]);
  const nv = await create(call, { version: 9 });
  expect([nv.status, nv.json.error.code]).toEqual([409, "version_not_confirmed"]);

  const first = await create(call);
  const again = await create(call);
  expect([again.status, again.json.error.code, again.json.error.details]).toEqual([409, "already_exists", { id: first.json.id }]);

  fake.mode.down = true;
  const down = await create(call, { version: 1, blueprintProjectId: "another" });
  expect([down.status, down.json.error.code]).toEqual([502, "blueprint_unreachable"]);
  expect((await call("GET", "/v1/projects")).json.projects).toHaveLength(1); // nothing was written by the refused ones
});

test("GET /v1/projects (+ counts) and GET /v1/projects/{id} (+ 404)", async () => {
  const { call, db } = await setup();
  const p = (await create(call)).json;
  const list = (await call("GET", "/v1/projects")).json.projects;
  expect(list).toEqual([{ ...p, cardsDone: 0, cardsTotal: 0, stuckCount: 0 }]);
  expect((await call("GET", `/v1/projects/${p.id}`)).json).toEqual(p);
  const nf = await call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099");
  expect([nf.status, nf.json.error.code]).toEqual([404, "not_found"]);

  // counts from the cards table: 4 cards — done (its spec changed, but it is finished: not stuck) · todo · stuck + spec changed (once) · an open question
  const at = new Date();
  const row = (n: number, over: Partial<typeof cards.$inferInsert>): typeof cards.$inferInsert => ({
    id: `55555555-5555-4555-8555-55555555555${n}`, projectId: p.id, number: n, kind: "work", title: `c${n}`, todo: "", status: "todo",
    anchorKey: "STEP-001", anchorVersion: 1, createdAt: at, updatedAt: at, ...over,
  });
  await db.insert(cards).values([
    row(1, { status: "done", specChangedVersion: 2 }), row(2, {}), row(3, { status: "stuck", specChangedVersion: 2 }),
    row(4, { kind: "question", question: { text: "q", proposedDefault: "d", cases: ["a"] } }),
  ]);
  const [sum] = (await call("GET", "/v1/projects")).json.projects;
  expect([sum.cardsDone, sum.cardsTotal, sum.stuckCount]).toEqual([1, 4, 2]);
});

test("GET /v1/projects/{id}/events: the project's events in seq order; `after` and `limit`; 404", async () => {
  const { call, db } = await setup();
  const p = (await create(call)).json;
  await db.insert(events).values([1, 2, 3].map((i) => ({ projectId: p.id, type: "project.mode_set", actor: "operator", at: new Date(), data: { i } })));
  const all = (await call("GET", `/v1/projects/${p.id}/events`)).json.events;
  expect(all.map((e: any) => e.type)).toEqual(["project.created", "project.mode_set", "project.mode_set", "project.mode_set"]);
  expect(Object.keys(all[0]).sort()).toEqual(["actor", "at", "data", "projectId", "seq", "type"]);
  const after = (await call("GET", `/v1/projects/${p.id}/events?after=${all[1].seq}&limit=1`)).json.events;
  expect(after.map((e: any) => e.seq)).toEqual([all[2].seq]);
  expect((await call("GET", `/v1/projects/${p.id}/events?limit=501`)).status).toBe(400);
  expect((await call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/events")).status).toBe(404);
});

test("POST /v1/projects/{id}/rebuild-check: same:true after a project; a table changed behind the events' back → same:false + diff; writes nothing; needs no actor", async () => {
  const { call, db } = await setup();
  const p = (await create(call)).json;
  const before = (await db.select().from(events)).length;
  expect((await call("POST", `/v1/projects/${p.id}/rebuild-check`, undefined, null)).json).toEqual({ same: true });
  await db.execute(sql`update caw.projects set hops_used = 7 where id = ${p.id}`);
  const bad = (await call("POST", `/v1/projects/${p.id}/rebuild-check`)).json;
  expect(bad.same).toBe(false);
  expect(bad.diff.tables.project.hopsUsed).toBe(7);
  expect(bad.diff.rebuilt.project.hopsUsed).toBe(0);
  expect((await db.select().from(events)).length).toBe(before);
  expect((await call("POST", "/v1/projects/00000000-0000-0000-0000-000000000099/rebuild-check")).status).toBe(404);
});

test("AC-1 no spec content: after a project is created, no column of any caw table holds Blueprint text — only the project name", async () => {
  const { call, db } = await setup();
  await create(call);
  // everything the recorded Blueprint answers carry: part titles, rule text … (the name is the one allowed exception)
  const version = JSON.parse(await Bun.file(new URL("../fixtures/blueprint/version-1-200.json", import.meta.url).pathname).text());
  const specTexts: string[] = [...new Set(version.parts.flatMap((p: any) => [p.title, p.body?.text, p.body?.rule, p.body?.note].filter((t: unknown): t is string => typeof t === "string" && t.length > 2)))] as string[];
  expect(specTexts.length).toBeGreaterThan(20);
  const rowsOf = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;
  const tables = await rowsOf<{ table_name: string; column_name: string }>(sql`select table_name, column_name from information_schema.columns where table_schema = 'caw' order by 1, 2`);
  expect(tables.length).toBeGreaterThan(60); // every column of every caw table is looked at
  const hits: string[] = [];
  for (const { table_name, column_name } of tables) {
    const rows = await rowsOf<{ v: string | null }>(sql.raw(`select "${column_name}"::text as v from caw."${table_name}"`));
    for (const { v } of rows) for (const t of specTexts) if (v?.includes(t) && !(table_name === "projects" && column_name === "name") && !(table_name === "events" && column_name === "data")) hits.push(`${table_name}.${column_name} ⊃ ${t}`);
  }
  expect(hits).toEqual([]);
  // events.data carries the project's name too (the same allowed exception) and nothing else of the spec
  const [ev] = await db.select().from(events);
  expect(Object.keys(ev!.data as object).sort()).toEqual(["blueprintProjectId", "id", "name", "version"]);
});

// ---- TASK-A-092 / contract v1.15 (D-082): one CAW project per Blueprint project, at ANY version ----
/** a project from before v1.15 (two CAW projects of one Blueprint project could exist): written as the event, through the normal write path */
async function legacyProject(db: Parameters<typeof writeEvent>[0], blueprintProjectId: string, version: number): Promise<string> {
  const id = crypto.randomUUID();
  await writeEvent(db, { type: "project.created", projectId: id, actor: "operator", at: new Date().toISOString(), data: { id, name: BP_NAME, blueprintProjectId, version } });
  return id;
}
const projectCount = async (call: (m: string, p: string) => Promise<{ json: any }>) => ((await call("GET", "/v1/projects")).json.projects as any[]).length;

test("v1.15: POST for v1, then POST for v2 of the SAME Blueprint project → 409 already_exists with the first project's id; nothing is written", async () => {
  const { call, db } = await setup();
  const first = await create(call, { version: 1 });
  expect(first.status).toBe(201);
  const eventsBefore = (await db.select().from(events)).length;
  const second = await create(call, { version: 2 });
  expect([second.status, second.json.error.code, second.json.error.details]).toEqual([409, "already_exists", { id: first.json.id }]);
  expect((await db.select().from(events)).length).toBe(eventsBefore);
  expect(await projectCount(call)).toBe(1);
  const v3 = await create(call, { version: 3 });
  expect([v3.status, v3.json.error.details]).toEqual([409, { id: first.json.id }]); // any version, not only v2
});

test("v1.15: a DIFFERENT Blueprint project still gets its own CAW project (201)", async () => {
  const { call } = await setup();
  const one = await create(call, { version: 1 });
  const two = await create(call, { blueprintProjectId: BP_PROJECT_2, version: 1 });
  expect([one.status, two.status]).toEqual([201, 201]);
  expect(two.json.id).not.toBe(one.json.id);
  const again = await create(call, { blueprintProjectId: BP_PROJECT_2, version: 2 });
  expect([again.status, again.json.error.details]).toEqual([409, { id: two.json.id }]); // the second Blueprint project is held to the same rule
  expect(await projectCount(call)).toBe(2);
});

test("v1.15: with two LEGACY projects of one Blueprint project (v1 and v2), POST v3 → 409 with the HIGHEST version's project id", async () => {
  const { call, db } = await setup();
  const v1 = await legacyProject(db, BP_PROJECT, 1);
  const v2 = await legacyProject(db, BP_PROJECT, 2);
  expect(await projectCount(call)).toBe(2); // the legacy duplicates are listed, untouched
  const r = await create(call, { version: 3 });
  expect([r.status, r.json.error.code, r.json.error.details]).toEqual([409, "already_exists", { id: v2 }]);
  expect(v1).not.toBe(v2);
  expect(await projectCount(call)).toBe(2); // nothing merged, nothing deleted, nothing added
});

test("v1.15: the older checks still come first — 400, then 404 blueprint_project_not_found, then 409 version_not_confirmed, and only then already_exists", async () => {
  const { call } = await setup();
  const first = await create(call, { version: 1 });
  expect((await create(call, { version: 0 })).status).toBe(400);
  const missing = await create(call, { blueprintProjectId: "00000000-0000-0000-0000-000000000099", version: 2 });
  expect([missing.status, missing.json.error.code]).toEqual([404, "blueprint_project_not_found"]);
  const unconfirmed = await create(call, { version: 9 }); // an unconfirmed version of a Blueprint project that already has a CAW project
  expect([unconfirmed.status, unconfirmed.json.error.code]).toEqual([409, "version_not_confirmed"]);
  const same = await create(call, { version: 1 });
  expect([same.status, same.json.error.code, same.json.error.details]).toEqual([409, "already_exists", { id: first.json.id }]);
});
