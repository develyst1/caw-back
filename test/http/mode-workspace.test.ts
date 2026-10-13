// TASK-A-073: PATCH …/mode (R6 — switching never resets anything) and PATCH …/workspace (v1.1, C-Q2).
import { expect, test } from "bun:test";
import { chainOf3, newCard, setup } from "../helpers/api";

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
  expect((await call("GET", `/v1/projects/${project.id}`)).json.workspace).toEqual({ roots: [] });
  const ok = await call("PATCH", W, { roots: ["/Users/me/work/app", "C:\\work\\app", "D:/work/web"] });
  expect(ok.status).toBe(200);
  expect(ok.json.workspace).toEqual({ roots: ["/Users/me/work/app", "C:\\work\\app", "D:/work/web"] });
  expect((await call("GET", `/v1/projects/${project.id}`)).json.workspace.roots).toHaveLength(3);
  expect((await call("PATCH", W, { roots: [] })).json.workspace).toEqual({ roots: [] });

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
