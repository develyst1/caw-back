// TASK-A-073: PATCH …/mode (R6 — switching never resets anything) and PATCH …/workspace (v1.1, C-Q2).
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { rebuild } from "../../src/core/rebuild";
import { events } from "../../src/db/schema";
import { chainOf3, mkWorker, newCard, setup } from "../helpers/api";

test("mode: set mode and (optionally) the hop budget; the other fields — hopsUsed, cards, hops — are never touched", async () => {
  const { call } = await setup();
  const { project, a } = await chainOf3(call);
  const P = `/v1/projects/${project.id}`;
  const card = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const hop = (await call("POST", `${P}/hops`, { cardId: card.id, workerId: a.id })).json;
  await call("PATCH", `/v1/hops/${hop.id}`, { outcome: "commented" });
  const before = { project: (await call("GET", P)).json, cards: (await call("GET", `${P}/cards`)).json, hops: (await call("GET", `${P}/hops`)).json };
  expect(before.project).toMatchObject({ mode: "manual", hopBudget: 0, hopsUsed: 1 });

  const r = await call("PATCH", `${P}/mode`, { mode: "dispatcher", hopBudget: 7 });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ...before.project, mode: "dispatcher", hopBudget: 7 });
  expect((await call("GET", `${P}/cards`)).json).toEqual(before.cards);
  expect((await call("GET", `${P}/hops`)).json).toEqual(before.hops);

  // back to manual without a budget: the budget stays, hopsUsed stays
  const back = await call("PATCH", `${P}/mode`, { mode: "manual" });
  expect(back.json).toEqual({ ...before.project, mode: "manual", hopBudget: 7 });
  expect((await call("PATCH", `${P}/mode`, { mode: "dispatcher", hopBudget: 0 })).json).toMatchObject({ hopBudget: 0, hopsUsed: 1 });
});

test("mode errors: bad mode / negative or fractional budget → 400 · a worker → 403 operator_only · unknown project → 404", async () => {
  const { call } = await setup();
  const { project, a } = await chainOf3(call);
  const P = `/v1/projects/${project.id}/mode`;
  expect((await call("PATCH", P, { mode: "auto" })).status).toBe(400);
  expect((await call("PATCH", P, { mode: "dispatcher", hopBudget: -1 })).status).toBe(400);
  expect((await call("PATCH", P, { mode: "dispatcher", hopBudget: 1.5 })).status).toBe(400);
  expect((await call("PATCH", P, {})).status).toBe(400);
  const w = await call("PATCH", P, { mode: "dispatcher" }, `worker:${a.id}`);
  expect([w.status, w.json.error.code]).toEqual([403, "operator_only"]);
  expect((await call("PATCH", "/v1/projects/00000000-0000-0000-0000-000000000099/mode", { mode: "manual" })).status).toBe(404);
});

test("workspace (v1.1): roots stored on the project — absolute, no `..`, ≤ 20, ≤ 500 chars; replaced as a whole; operator only", async () => {
  const { call } = await setup();
  const { project, a } = await chainOf3(call);
  const W = `/v1/projects/${project.id}/workspace`;
  expect((await call("GET", `/v1/projects/${project.id}`)).json.workspace).toEqual({ roots: [], readOnly: [] });
  const ok = await call("PATCH", W, { roots: ["/Users/me/work/app", "C:\\work\\app", "D:/work/web"] });
  expect(ok.status).toBe(200);
  expect(ok.json.workspace).toEqual({ roots: ["/Users/me/work/app", "C:\\work\\app", "D:/work/web"], readOnly: [] });
  expect((await call("GET", `/v1/projects/${project.id}`)).json.workspace.roots).toHaveLength(3);
  expect((await call("PATCH", W, { roots: [] })).json.workspace).toEqual({ roots: [], readOnly: [] });

  const bad = async (roots: unknown) => (await call("PATCH", W, { roots })).status;
  expect(await bad(["relative/path"])).toBe(400);
  expect(await bad(["./here"])).toBe(400);
  expect(await bad([""])).toBe(400);
  expect(await bad(["/a/../b"])).toBe(400);
  expect(await bad(["/a/.."])).toBe(400);
  expect(await bad(["C:\\a\\..\\b"])).toBe(400);
  expect(await bad(["/" + "x".repeat(500)])).toBe(400);
  expect(await bad(Array.from({ length: 21 }, (_, i) => `/r${i}`))).toBe(400);
  expect(await bad("/not/a/list")).toBe(400);
  expect(await bad(Array.from({ length: 20 }, (_, i) => `/r${i}`))).toBe(200);
  expect(await bad(["/a/b..c", "/a/..hidden"])).toBe(200); // `..` only as a whole segment
  expect((await call("GET", `/v1/projects/${project.id}`)).json.workspace.roots).toEqual(["/a/b..c", "/a/..hidden"]);

  const w = await call("PATCH", W, { roots: ["/x"] }, `worker:${a.id}`);
  expect([w.status, w.json.error.code]).toEqual([403, "operator_only"]);
  expect((await call("PATCH", "/v1/projects/00000000-0000-0000-0000-000000000099/workspace", { roots: [] })).status).toBe(404);
});

// ---- TASK-A-094 Revision 2 / SPEC-A-009 § Revision 2 (D-100): read-only folders ----
test("workspace.readOnly (v1.16): PATCH { roots, readOnly } stores it; readOnly ⊆ roots else 400; default []; replaced as a whole; the event carries it", async () => {
  const { call, db } = await setup();
  const { project } = await chainOf3(call);
  const W = `/v1/projects/${project.id}/workspace`;
  const roots = ["/Users/me/work/app", "/Users/me/work/api", "/Users/me/work/mc2-spec"];
  const ok = await call("PATCH", W, { roots, readOnly: [roots[2]] });
  expect([ok.status, ok.json.workspace]).toEqual([200, { roots, readOnly: [roots[2]] }]);
  expect((await call("GET", `/v1/projects/${project.id}`)).json.workspace).toEqual({ roots, readOnly: [roots[2]] });
  const outside = await call("PATCH", W, { roots, readOnly: ["/Users/me/work/elsewhere"] });
  expect([outside.status, outside.json.error.code]).toEqual([400, "validation"]);
  expect((await call("PATCH", W, { roots: [roots[0]], readOnly: [roots[2]] })).status).toBe(400); // readOnly entry no longer in roots
  expect((await call("GET", `/v1/projects/${project.id}`)).json.workspace.readOnly).toEqual([roots[2]]); // the refusals wrote nothing
  expect((await call("PATCH", W, { roots })).json.workspace).toEqual({ roots, readOnly: [] }); // not sent → [] (today's callers keep "all writable")
  expect((await call("PATCH", W, { roots, readOnly: [roots[0], roots[1], roots[2]] })).json.workspace.readOnly).toEqual(roots); // all read-only is allowed here (Team C stops the hop)
  expect((await call("PATCH", W, { roots, readOnly: [roots[1], roots[1]] })).status).toBe(400); // a repeat
  const asWorker = await call("PATCH", W, { roots, readOnly: [] }, `worker:${(await mkW(call)).id}`);
  expect(asWorker.json.error.code).toBe("operator_only");
  const evs = (await db.select().from(events)).filter((e) => e.type === "project.workspace_set");
  expect(evs.at(-1)!.data).toEqual({ roots, readOnly: [roots[0], roots[1], roots[2]] });
});

test("an OLD project.workspace_set event (no readOnly) replays with readOnly [], and so does an old project row; rebuild-check is same:true", async () => {
  const { call, db } = await setup();
  const { project } = await chainOf3(call);
  const roots = ["/Users/me/work/app"];
  await db.insert(events).values({ projectId: project.id, type: "project.workspace_set", actor: "operator", at: new Date(), data: { roots } }); // before v1.16: only roots
  const state = await rebuild(db, project.id);
  expect(state.project!.workspace).toEqual({ roots, readOnly: [] });
  await db.execute(sql`update caw.projects set workspace = ${JSON.stringify({ roots })}::jsonb where id = ${project.id}`); // a row written before v1.16
  expect((await call("GET", `/v1/projects/${project.id}`)).json.workspace).toEqual({ roots, readOnly: [] });
  expect((await call("POST", `/v1/projects/${project.id}/rebuild-check`)).json).toEqual({ same: true });
  await call("PATCH", `/v1/projects/${project.id}/workspace`, { roots: [...roots, "/Users/me/work/spec"], readOnly: ["/Users/me/work/spec"] });
  expect((await call("POST", `/v1/projects/${project.id}/rebuild-check`)).json).toEqual({ same: true });
});

async function mkW(call: Parameters<typeof mkWorker>[0]) { return mkWorker(call, "W-readonly"); }
