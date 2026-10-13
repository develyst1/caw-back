// TASK-A-072: workers (create · defaults · combine — AC-5) and the chain (members · edges · entry · re-assign — AC-5).
import { expect, test } from "bun:test";
import { chainOf3, mkWorker, newCard, setup } from "../helpers/api";

test("POST /v1/workers: 201 Worker; model / effort default by role (PM·SA·QA opus/medium · FE·BE·other sonnet/medium); explicit values kept", async () => {
  const { call } = await setup();
  const got = async (role: string, extra: object = {}) => {
    const w = await mkWorker(call, `w-${role}-${JSON.stringify(extra).length}`, role, ["skill-a"], extra);
    return [w.model, w.effort];
  };
  expect(await got("PM")).toEqual(["opus", "medium"]);
  expect(await got("SA")).toEqual(["opus", "medium"]);
  expect(await got("QA")).toEqual(["opus", "medium"]);
  expect(await got("FE")).toEqual(["sonnet", "medium"]);
  expect(await got("BE")).toEqual(["sonnet", "medium"]);
  expect(await got("other")).toEqual(["sonnet", "medium"]);
  expect(await got("BE", { model: "haiku", effort: "high" })).toEqual(["haiku", "high"]);
  const w = await mkWorker(call, "Jason", "BE", ["role-be", "workforce-protocol"]);
  expect(w).toEqual({ id: w.id, name: "Jason", role: "BE", skills: ["role-be", "workforce-protocol"], model: "sonnet", effort: "medium", combinedFrom: null });
  expect((await call("GET", "/v1/workers")).json.workers.map((x: any) => x.name)).toContain("Jason");
});

test("POST /v1/workers validation: name 1–40 · role enum · ≥ 1 skill · 409 name_taken · operator only", async () => {
  const { call } = await setup();
  const bad = (body: object) => call("POST", "/v1/workers", body).then((r) => r.status);
  expect(await bad({ name: "", role: "BE", skills: ["x"] })).toBe(400);
  expect(await bad({ name: "x".repeat(41), role: "BE", skills: ["x"] })).toBe(400);
  expect(await bad({ name: "a", role: "CEO", skills: ["x"] })).toBe(400);
  expect(await bad({ name: "a", role: "BE", skills: [] })).toBe(400);
  expect(await bad({ name: "a", role: "BE", skills: [""] })).toBe(400);
  expect(await bad({ name: "a", role: "BE", skills: ["x"], model: "gpt" })).toBe(400);
  expect(await bad({ name: "a", role: "BE" })).toBe(400);
  expect((await call("POST", "/v1/workers", { name: "a", role: "BE", skills: ["x"] })).status).toBe(201);
  const dup = await call("POST", "/v1/workers", { name: "a", role: "FE", skills: ["y"] });
  expect([dup.status, dup.json.error.code]).toEqual([409, "name_taken"]);
  const w = await mkWorker(call, "worker-one");
  const r = await call("POST", "/v1/workers", { name: "z", role: "BE", skills: ["x"] }, `worker:${w.id}`);
  expect([r.status, r.json.error.code]).toEqual([403, "operator_only"]);
});

test("AC-5 combine: skills = union (order kept, no repeats) · the stronger model · the higher effort · role other · combinedFrom [a, b] · the originals stay", async () => {
  const { call } = await setup();
  const a = await mkWorker(call, "Ann", "PM", ["s1", "s2"], { model: "opus", effort: "low" });
  const b = await mkWorker(call, "Ben", "FE", ["s2", "s3"], { model: "haiku", effort: "high" });
  const r = await call("POST", "/v1/workers/combine", { name: "AnnBen", workerIds: [a.id, b.id] });
  expect(r.status).toBe(201);
  expect(r.json).toEqual({ id: r.json.id, name: "AnnBen", role: "other", skills: ["s1", "s2", "s3"], model: "opus", effort: "high", combinedFrom: [a.id, b.id] });
  const names = (await call("GET", "/v1/workers")).json.workers.map((w: any) => w.name).sort();
  expect(names).toEqual(["Ann", "AnnBen", "Ben"]);
  const c = await mkWorker(call, "Cat", "BE", ["s9"], { model: "haiku", effort: "low" });
  const d = await mkWorker(call, "Dan", "BE", ["s8"], { model: "sonnet", effort: "medium" });
  expect((await call("POST", "/v1/workers/combine", { name: "CatDan", workerIds: [c.id, d.id] })).json).toMatchObject({ model: "sonnet", effort: "medium" });
});

test("combine errors: same id twice · not two ids → 400 · unknown worker → 404 · name_taken → 409 · operator only", async () => {
  const { call } = await setup();
  const a = await mkWorker(call, "Ann"); const b = await mkWorker(call, "Ben");
  const post = (body: object, actor = "operator") => call("POST", "/v1/workers/combine", body, actor);
  expect((await post({ name: "x", workerIds: [a.id, a.id] })).status).toBe(400);
  expect((await post({ name: "x", workerIds: [a.id] })).status).toBe(400);
  expect((await post({ name: "x", workerIds: [a.id, b.id, a.id] })).status).toBe(400);
  expect((await post({ name: "x", workerIds: [a.id, "00000000-0000-0000-0000-000000000099"] })).status).toBe(404);
  const taken = await post({ name: "Ann", workerIds: [a.id, b.id] });
  expect([taken.status, taken.json.error.code]).toEqual([409, "name_taken"]);
  expect((await post({ name: "x", workerIds: [a.id, b.id] }, `worker:${a.id}`)).status).toBe(403);
});

test("chain: members · edges · entry — and each refusal the SPEC names", async () => {
  const { call } = await setup();
  const { project, a, b, c } = await chainOf3(call);
  const P = `/v1/projects/${project.id}`;
  const stranger = await mkWorker(call, "Zed");
  expect((await call("GET", `${P}/chain`)).json).toMatchObject({ edges: [], entryWorkerId: null });
  expect((await call("GET", `${P}/chain`)).json.members.map((w: any) => w.name).sort()).toEqual(["Ann", "Ben", "Cat"]);
  expect((await call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/chain")).status).toBe(404);

  const dup = await call("POST", `${P}/chain/members`, { workerId: a.id });
  expect([dup.status, dup.json.error.code]).toEqual([409, "already_member"]);
  expect((await call("POST", `${P}/chain/members`, { workerId: "00000000-0000-0000-0000-000000000099" })).status).toBe(404);
  expect((await call("POST", `${P}/chain/members`, { workerId: stranger.id }, `worker:${a.id}`)).json.error.code).toBe("operator_only");

  expect((await call("POST", `${P}/chain/edges`, { from: a.id, to: b.id })).json.edges).toEqual([{ from: a.id, to: b.id }]);
  expect((await call("POST", `${P}/chain/edges`, { from: a.id, to: b.id })).json.error.code).toBe("edge_exists");
  expect((await call("POST", `${P}/chain/edges`, { from: b.id, to: a.id })).status).toBe(200); // directed: the reverse is its own edge
  const self = await call("POST", `${P}/chain/edges`, { from: a.id, to: a.id });
  expect(self.status).toBe(400);
  const out = await call("POST", `${P}/chain/edges`, { from: a.id, to: stranger.id });
  expect([out.status, out.json.error.code]).toEqual([400, "not_a_member"]);
  expect((await call("DELETE", `${P}/chain/edges`, { from: b.id, to: a.id })).json.edges).toEqual([{ from: a.id, to: b.id }]);
  expect((await call("DELETE", `${P}/chain/edges`, { from: b.id, to: a.id })).status).toBe(404);

  expect((await call("PUT", `${P}/chain/entry`, { workerId: stranger.id })).json.error.code).toBe("not_a_member");
  expect((await call("PUT", `${P}/chain/entry`, { workerId: c.id })).json.entryWorkerId).toBe(c.id);
  expect((await call("GET", `/v1/projects/${project.id}`)).json.entryWorkerId).toBe(c.id);
  const isEntry = await call("DELETE", `${P}/chain/members/${c.id}`);
  expect([isEntry.status, isEntry.json.error.code]).toEqual([409, "is_entry"]);
});

test("AC-5 re-assign: removing a member with open cards needs reassignTo; the 3 open cards move, none is lost; its edges go; done cards stay", async () => {
  const { call } = await setup();
  const { project, a, b } = await chainOf3(call);
  const P = `/v1/projects/${project.id}`;
  await call("POST", `${P}/chain/edges`, { from: a.id, to: b.id });
  const open: string[] = [];
  for (let i = 0; i < 3; i++) open.push((await newCard(call, project.id, { title: `งาน ${i}`, assigneeId: a.id })).json.id);
  const doneCard = (await newCard(call, project.id, { title: "เสร็จแล้ว", assigneeId: a.id })).json.id;
  expect((await call("PATCH", `/v1/cards/${doneCard}/status`, { status: "done" })).status).toBe(200);
  const total = (await call("GET", `${P}/cards`)).json.cards.length;

  const refused = await call("DELETE", `${P}/chain/members/${a.id}`);
  expect([refused.status, refused.json.error.code]).toEqual([409, "has_open_cards"]);
  const toStranger = await call("DELETE", `${P}/chain/members/${a.id}?reassignTo=00000000-0000-0000-0000-000000000099`);
  expect([toStranger.status, toStranger.json.error.code]).toEqual([400, "not_a_member"]);
  const toSelf = await call("DELETE", `${P}/chain/members/${a.id}?reassignTo=${a.id}`);
  expect(toSelf.status).toBe(400);

  const ok = await call("DELETE", `${P}/chain/members/${a.id}?reassignTo=${b.id}`);
  expect(ok.status).toBe(200);
  expect(ok.json.members.map((w: any) => w.name).sort()).toEqual(["Ben", "Cat"]);
  expect(ok.json.edges).toEqual([]);
  const cards = (await call("GET", `${P}/cards`)).json.cards;
  expect(cards).toHaveLength(total);
  expect(cards.filter((x: any) => open.includes(x.id)).map((x: any) => x.assigneeId)).toEqual([b.id, b.id, b.id]);
  expect(cards.find((x: any) => x.id === doneCard).assigneeId).toBe(a.id);
  expect((await call("DELETE", `${P}/chain/members/${a.id}`)).status).toBe(404); // no longer a member
});
