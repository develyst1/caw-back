// TASK-A-086 / contract v1.12 (D-068, REQ-014 R7): a worker's chosen face, `avatar { body, color, eyes } | null`. The core checks the SHAPE
// (three keys, each `^[a-z0-9-]{1,24}$`), never the ids against a list — that list is the screen's. null = not chosen.
import { eq } from "drizzle-orm";
import { expect, test } from "bun:test";
import { rebuild } from "../../src/core/rebuild";
import { events } from "../../src/db/schema";
import { chainOf3, setup } from "../helpers/api";

const FACE = { body: "round", color: "teal", eyes: "dots" };

async function world() {
  const s = await setup();
  const post = (body: object, actor: string = "operator") => s.call("POST", "/v1/workers", body, actor);
  const patch = (id: string, body: object, actor: string = "operator") => s.call("PATCH", `/v1/workers/${id}`, body, actor);
  const updates = async () => (await s.db.select().from(events).where(eq(events.type, "worker.updated"))).map((e) => e.data);
  const get = async (id: string) => ((await s.call("GET", "/v1/workers")).json.workers as any[]).find((w) => w.id === id);
  const make = async (extra: object = {}) => (await post({ name: "Ann", roles: ["BE"], skills: ["s"], ...extra })).json;
  return { ...s, post, patch, updates, get, make };
}

test("POST without avatar → avatar null (answer and list); with one → stored and returned exactly as sent; an explicit null is null", async () => {
  const w = await world();
  const none = await w.post({ name: "none", roles: ["BE"], skills: ["s"] });
  expect([none.status, none.json.avatar]).toEqual([201, null]);
  expect((await w.get(none.json.id)).avatar).toBeNull();
  const given = await w.post({ name: "given", roles: ["BE"], skills: ["s"], avatar: FACE });
  expect([given.status, given.json.avatar]).toEqual([201, FACE]);
  expect((await w.get(given.json.id)).avatar).toEqual(FACE); // stored, not just answered
  const explicit = await w.post({ name: "explicit", roles: ["BE"], skills: ["s"], avatar: null });
  expect([explicit.status, explicit.json.avatar]).toEqual([201, null]);
  const old = await w.post({ name: "old-shape", role: "QA", skills: ["s"], avatar: FACE }); // the v1.9 `role` shape takes an avatar too
  expect([old.status, old.json.avatar, old.json.roles]).toEqual([201, FACE, ["QA"]]);
});

test("PATCH avatar sets it and NOTHING else changes; exactly one worker.updated event, carrying only { id, avatar }", async () => {
  const w = await world();
  const made = await w.make({ model: "haiku", effort: "high" });
  const r = await w.patch(made.id, { avatar: FACE });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ...made, avatar: FACE });
  expect(await w.updates()).toEqual([{ id: made.id, avatar: FACE }]);
  expect(await w.get(made.id)).toEqual(r.json);
});

test("PATCH avatar: null clears it — and counts as one of the 'at least one field' keys (200, not 400); {} is still 400", async () => {
  const w = await world();
  const made = await w.make({ avatar: FACE });
  const cleared = await w.patch(made.id, { avatar: null });
  expect([cleared.status, cleared.json.avatar]).toEqual([200, null]);
  expect(await w.updates()).toEqual([{ id: made.id, avatar: null }]);
  expect((await w.get(made.id)).avatar).toBeNull();
  expect((await w.patch(made.id, {})).status).toBe(400);
  const again = await w.patch(made.id, { name: "Ann2" }); // a patch that does not mention avatar leaves it alone
  expect(again.json.avatar).toBeNull();
  await w.patch(made.id, { avatar: { ...FACE, color: "plum" } });
  expect((await w.patch(made.id, { name: "Ann3" })).json.avatar).toEqual({ ...FACE, color: "plum" });
});

test("400 validation and NOTHING written: a partial object · an extra key · a capital · a space · 25 chars · an empty id · an underscore · a non-object · an array · a missing key", async () => {
  const w = await world();
  const made = await w.make();
  const bad: [string, unknown][] = [
    ["partial", { color: "teal" }], ["missing eyes", { body: "round", color: "teal" }], ["extra key", { ...FACE, hat: "red" }],
    ["capital", { ...FACE, body: "Round" }], ["space", { ...FACE, color: "te al" }], ["25 chars", { ...FACE, eyes: "a".repeat(25) }],
    ["empty id", { ...FACE, eyes: "" }], ["underscore", { ...FACE, body: "r_ound" }], ["string", "teal"], ["array", [FACE]], ["number id", { ...FACE, body: 1 }], ["empty object", {}],
  ];
  const before = (await w.call("GET", "/v1/workers")).json.workers;
  for (const [label, avatar] of bad) {
    const onPost = await w.post({ name: `p-${label}`, roles: ["BE"], skills: ["s"], avatar });
    expect([label, "POST", onPost.status, onPost.json.error?.code]).toEqual([label, "POST", 400, "validation"]);
    const onPatch = await w.patch(made.id, { avatar });
    expect([label, "PATCH", onPatch.status, onPatch.json.error?.code]).toEqual([label, "PATCH", 400, "validation"]);
  }
  expect((await w.call("GET", "/v1/workers")).json.workers).toEqual(before); // no worker added, none changed
  expect(await w.updates()).toEqual([]);
});

test("the edges that ARE valid: 24 characters, digits, hyphens", async () => {
  const w = await world();
  const r = await w.post({ name: "edge", roles: ["BE"], skills: ["s"], avatar: { body: "a".repeat(24), color: "0-9", eyes: "x" } });
  expect([r.status, r.json.avatar]).toEqual([201, { body: "a".repeat(24), color: "0-9", eyes: "x" }]);
});

test("the core does NOT check ids against any list: an id the screen has never heard of is stored and returned", async () => {
  const w = await world();
  const r = await w.post({ name: "odd", roles: ["BE"], skills: ["s"], avatar: { body: "zz-9", color: "not-a-colour", eyes: "q" } });
  expect([r.status, r.json.avatar]).toEqual([201, { body: "zz-9", color: "not-a-colour", eyes: "q" }]);
  expect((await w.patch(r.json.id, { avatar: { body: "zz-10", color: "x", eyes: "y" } })).json.avatar).toEqual({ body: "zz-10", color: "x", eyes: "y" });
});

test("a worker or a runner cannot set an avatar (the same rules as the other fields): POST 403 operator_only · PATCH 403 operator_only / runner_not_allowed", async () => {
  const w = await world();
  const made = await w.make();
  const asWorker = await w.patch(made.id, { avatar: FACE }, `worker:${made.id}`);
  expect([asWorker.status, asWorker.json.error.code]).toEqual([403, "operator_only"]);
  expect((await w.patch(made.id, { avatar: FACE }, "runner:r1")).json.error.code).toBe("runner_not_allowed");
  expect((await w.get(made.id)).avatar).toBeNull();
});

test("a combined worker (deprecated route) has avatar null", async () => {
  const w = await world();
  const a = await w.make({ avatar: FACE });
  const b = (await w.post({ name: "Ben", roles: ["FE"], skills: ["t"], avatar: { ...FACE, body: "square" } })).json;
  const r = await w.call("POST", "/v1/workers/combine", { name: "AnnBen", workerIds: [a.id, b.id] });
  expect([r.status, r.json.avatar]).toEqual([201, null]);
});

test("OLD events replay: a worker.created without avatar (legacy `role` shape and v1.10 `roles` shape) and a worker.combined → avatar null; an event WITH avatar keeps it", async () => {
  const w = await world();
  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const at = new Date();
  await w.db.insert(events).values([
    { projectId: null, type: "worker.created", actor: "operator", at, data: { id: U(1), name: "Legacy", role: "BE", skills: ["s"], model: "sonnet", effort: "medium" } },
    { projectId: null, type: "worker.created", actor: "operator", at, data: { id: U(2), name: "V110", roles: ["PM", "BA"], skills: ["s"], model: "opus", effort: "medium" } },
    { projectId: null, type: "worker.combined", actor: "operator", at, data: { id: U(3), name: "Both", roles: ["other"], skills: ["s"], model: "opus", effort: "medium", combinedFrom: [U(1), U(2)] } },
    { projectId: null, type: "worker.created", actor: "operator", at, data: { id: U(4), name: "Faced", roles: ["BE"], skills: ["s"], model: "sonnet", effort: "medium", avatar: FACE } },
  ]);
  const state = await rebuild(w.db, U(99));
  expect(state.workers.map((x) => [x.name, x.avatar])).toEqual([["Legacy", null], ["V110", null], ["Both", null], ["Faced", FACE]]);
});

test("rebuild-check is same:true after create with an avatar · patch · clear · patch again, and the replay gives the same avatar", async () => {
  const w = await world();
  const { project, a } = await chainOf3(w.call);
  const faced = await w.make({ name: "Faced", avatar: FACE });
  await w.patch(a.id, { avatar: FACE });
  await w.patch(a.id, { avatar: null });
  await w.patch(a.id, { avatar: { body: "tall", color: "plum", eyes: "wide" } });
  await w.patch(faced.id, { avatar: null });
  expect((await w.call("POST", `/v1/projects/${project.id}/rebuild-check`)).json).toEqual({ same: true });
  const rebuilt = (await rebuild(w.db, project.id)).workers;
  expect([rebuilt.find((x) => x.id === a.id)!.avatar, rebuilt.find((x) => x.id === faced.id)!.avatar]).toEqual([{ body: "tall", color: "plum", eyes: "wide" }, null]);
});
