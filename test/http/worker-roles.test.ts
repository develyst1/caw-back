// TASK-A-084 / contract v1.10 (D-060, REQ-014 R6): a worker holds several roles. `roles` (≥ 1, distinct, BA is new) replaces `role`, which
// stays in every response as roles[0] (deprecated). POST takes `roles` or the old `role`; PATCH /v1/workers/{id} edits a worker.
import { eq } from "drizzle-orm";
import { expect, test } from "bun:test";
import { rebuild } from "../../src/core/rebuild";
import { events } from "../../src/db/schema";
import { chainOf3, setup } from "../helpers/api";

async function world() {
  const s = await setup();
  const post = (body: object, actor: string = "operator") => s.call("POST", "/v1/workers", body, actor);
  const patch = (id: string, body: object, actor: string = "operator") => s.call("PATCH", `/v1/workers/${id}`, body, actor);
  const updates = async () => (await s.db.select().from(events).where(eq(events.type, "worker.updated"))).map((e) => [e.actor, e.projectId, e.data]);
  const get = async (id: string) => ((await s.call("GET", "/v1/workers")).json.workers as any[]).find((w) => w.id === id);
  return { ...s, post, patch, updates, get };
}

test("POST roles: [PM, BA] → 201, roles in the order sent, role = roles[0], model / effort = the strongest default (opus / medium)", async () => {
  const w = await world();
  const r = await w.post({ name: "Pam", roles: ["PM", "BA"], skills: ["role-pm", "role-ba"] });
  expect(r.status).toBe(201);
  expect(r.json).toEqual({ id: r.json.id, name: "Pam", roles: ["PM", "BA"], role: "PM", skills: ["role-pm", "role-ba"], model: "opus", effort: "medium", combinedFrom: null, avatar: null, deletedAt: null });
});

test("POST roles: the order is kept and role follows it · the strongest default of the roles wins · explicit model / effort win over defaults · BA alone is opus / medium", async () => {
  const w = await world();
  const fb = (await w.post({ name: "a", roles: ["FE", "BE"], skills: ["x"] })).json;
  expect([fb.roles, fb.role, fb.model, fb.effort]).toEqual([["FE", "BE"], "FE", "sonnet", "medium"]);
  const bf = (await w.post({ name: "b", roles: ["BE", "FE"], skills: ["x"] })).json;
  expect([bf.roles, bf.role]).toEqual([["BE", "FE"], "BE"]);
  const mixed = (await w.post({ name: "c", roles: ["FE", "PM", "BE"], skills: ["x"] })).json;
  expect([mixed.model, mixed.effort]).toEqual(["opus", "medium"]); // one thinking role lifts the worker
  const explicit = (await w.post({ name: "d", roles: ["PM", "SA"], skills: ["x"], model: "haiku", effort: "low" })).json;
  expect([explicit.model, explicit.effort]).toEqual(["haiku", "low"]);
  const ba = (await w.post({ name: "e", roles: ["BA"], skills: ["x"] })).json;
  expect([ba.roles, ba.model, ba.effort]).toEqual([["BA"], "opus", "medium"]);
});

test("POST with the old `role: QA` → roles [QA] (read as [role]), role QA, opus / medium — nothing a client of v1.9 sends stops working", async () => {
  const w = await world();
  const r = await w.post({ name: "Quin", role: "QA", skills: ["role-qa"] });
  expect(r.status).toBe(201);
  expect(r.json).toEqual({ id: r.json.id, name: "Quin", roles: ["QA"], role: "QA", skills: ["role-qa"], model: "opus", effort: "medium", combinedFrom: null, avatar: null, deletedAt: null });
});

test("POST validation: roles [] · repeated · outside the enum · both role and roles · neither → 400 validation, and nothing is written", async () => {
  const w = await world();
  const bad = async (extra: object) => {
    const r = await w.post({ name: "x", skills: ["s"], ...extra });
    return [r.status, r.json.error?.code];
  };
  expect(await bad({ roles: [] })).toEqual([400, "validation"]);
  expect(await bad({ roles: ["FE", "FE"] })).toEqual([400, "validation"]);
  expect(await bad({ roles: ["XX"] })).toEqual([400, "validation"]);
  expect(await bad({ roles: ["FE"], role: "FE" })).toEqual([400, "validation"]);
  expect(await bad({})).toEqual([400, "validation"]);
  expect(await bad({ role: "CEO" })).toEqual([400, "validation"]);
  expect((await w.call("GET", "/v1/workers")).json.workers).toEqual([]); // none of the refused ones wrote a worker
  const known = (await w.post({ name: "known", roles: ["FE"], skills: ["s"] })).json;
  const asWorker = await w.post({ name: "x", roles: ["FE"], skills: ["s"] }, `worker:${known.id}`);
  expect([asWorker.status, asWorker.json.error.code]).toEqual([403, "operator_only"]);
  expect((await w.call("GET", "/v1/workers")).json.workers.map((x: any) => x.name)).toEqual(["known"]); // and the refused worker write added nothing
});

test("GET /v1/workers lists roles and role for every worker", async () => {
  const w = await world();
  await w.post({ name: "one", roles: ["PM", "BA"], skills: ["s"] });
  await w.post({ name: "two", role: "SA", skills: ["s"] });
  expect(((await w.call("GET", "/v1/workers")).json.workers as any[]).map((x) => [x.name, x.roles, x.role]).sort()).toEqual([["one", ["PM", "BA"], "PM"], ["two", ["SA"], "SA"]]);
});

test("PATCH roles only → only roles (and role) change: model, effort, skills and name stay; exactly one worker.updated event, with only the field sent", async () => {
  const w = await world();
  const made = (await w.post({ name: "Pam", roles: ["PM"], skills: ["role-pm", "extra"], model: "haiku", effort: "high" })).json;
  const r = await w.patch(made.id, { roles: ["BA", "PM"] });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ...made, roles: ["BA", "PM"], role: "BA" });
  expect(await w.updates()).toEqual([["operator", null, { id: made.id, roles: ["BA", "PM"] }]]);
  expect(await w.get(made.id)).toEqual(r.json); // stored, not just answered
});

test("PATCH name · skills · model · effort each set only what is sent; sending the worker's own name is fine", async () => {
  const w = await world();
  const made = (await w.post({ name: "Pam", roles: ["PM"], skills: ["a"] })).json;
  expect((await w.patch(made.id, { name: "Pamela" })).json).toMatchObject({ name: "Pamela", roles: ["PM"], skills: ["a"], model: "opus" });
  expect((await w.patch(made.id, { skills: ["a", "b"] })).json).toMatchObject({ name: "Pamela", skills: ["a", "b"] });
  expect((await w.patch(made.id, { model: "sonnet", effort: "low" })).json).toMatchObject({ model: "sonnet", effort: "low", skills: ["a", "b"] });
  expect((await w.patch(made.id, { name: "Pamela" })).status).toBe(200);
  expect(await w.updates()).toHaveLength(4);
});

test("PATCH refusals: name taken 409 name_taken · unknown / non-uuid id 404 · {} 400 · bad fields 400 · a worker 403 operator_only · a runner 403 runner_not_allowed — none writes an event", async () => {
  const w = await world();
  const a = (await w.post({ name: "Ann", roles: ["BE"], skills: ["s"] })).json;
  const b = (await w.post({ name: "Ben", roles: ["FE"], skills: ["s"] })).json;
  const taken = await w.patch(b.id, { name: "Ann" });
  expect([taken.status, taken.json.error.code]).toEqual([409, "name_taken"]);
  expect((await w.patch("00000000-0000-4000-8000-000000000099", { name: "Zed" })).status).toBe(404);
  expect((await w.patch("not-a-uuid", { name: "Zed" })).status).toBe(404);
  for (const body of [{}, { roles: [] }, { roles: ["FE", "FE"] }, { roles: ["XX"] }, { skills: [] }, { name: "" }, { name: "x".repeat(41) }, { model: "gpt" }, { effort: "max" }]) {
    expect([JSON.stringify(body), (await w.patch(a.id, body)).status]).toEqual([JSON.stringify(body), 400]);
  }
  const asWorker = await w.patch(a.id, { name: "Zed" }, `worker:${a.id}`);
  expect([asWorker.status, asWorker.json.error.code]).toEqual([403, "operator_only"]);
  const asRunner = await w.patch(a.id, { name: "Zed" }, "runner:r1");
  expect([asRunner.status, asRunner.json.error.code]).toEqual([403, "runner_not_allowed"]);
  expect(await w.updates()).toEqual([]);
  expect((await w.get(a.id)).name).toBe("Ann");
});

test("a combined worker (the deprecated route, unchanged) lists roles [other], role other, combinedFrom set", async () => {
  const w = await world();
  const a = (await w.post({ name: "Ann", roles: ["BE"], skills: ["s1"] })).json;
  const b = (await w.post({ name: "Ben", roles: ["PM", "BA"], skills: ["s2"] })).json;
  const r = await w.call("POST", "/v1/workers/combine", { name: "AnnBen", workerIds: [a.id, b.id] });
  expect(r.status).toBe(201);
  expect(r.json).toMatchObject({ name: "AnnBen", roles: ["other"], role: "other", combinedFrom: [a.id, b.id], model: "opus", skills: ["s1", "s2"] });
});

test("OLD events replay: a worker.created with `role` → roles [role]; a worker.combined → roles [other] — the events table is never rewritten", async () => {
  const w = await world();
  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const at = new Date();
  await w.db.insert(events).values([
    { projectId: null, type: "worker.created", actor: "operator", at, data: { id: U(1), name: "Old", role: "BE", skills: ["s"], model: "sonnet", effort: "medium" } },
    { projectId: null, type: "worker.created", actor: "operator", at, data: { id: U(2), name: "Old2", role: "QA", skills: ["s"], model: "opus", effort: "medium" } },
    { projectId: null, type: "worker.combined", actor: "operator", at, data: { id: U(3), name: "OldBoth", role: "other", skills: ["s"], model: "opus", effort: "medium", combinedFrom: [U(1), U(2)] } },
  ]);
  const state = await rebuild(w.db, U(99));
  expect(state.workers.map((x) => [x.name, x.roles, "role" in x])).toEqual([["Old", ["BE"], false], ["Old2", ["QA"], false], ["OldBoth", ["other"], false]]);
});

test("rebuild-check is same:true after create (roles and old role) · patch · combine, and the new worker.updated replays to the same state", async () => {
  const w = await world();
  const { project, a, b } = await chainOf3(w.call);
  await w.post({ name: "Pam", roles: ["PM", "BA"], skills: ["role-pm"] });
  await w.patch(a.id, { roles: ["BE", "SA"] });
  await w.patch(b.id, { name: "Benny", skills: ["x", "y"], model: "haiku" });
  await w.call("POST", "/v1/workers/combine", { name: "AB", workerIds: [a.id, b.id] });
  expect((await w.call("POST", `/v1/projects/${project.id}/rebuild-check`)).json).toEqual({ same: true });
  const rebuilt = (await rebuild(w.db, project.id)).workers.find((x) => x.id === a.id)!;
  expect([rebuilt.roles, rebuilt.name]).toEqual([["BE", "SA"], "Ann"]);
});
