// TASK-A-091 / contract v1.14 (D-081 ask 1): delete a worker. The worker is KEPT (old hops and cards point at them): `deletedAt` is set, the list
// still shows them, and every write that names them treats them as unknown. Refused while any chain has them. Their name is free again.
import { eq } from "drizzle-orm";
import { expect, test } from "bun:test";
import { rebuild } from "../../src/core/rebuild";
import { events } from "../../src/db/schema";
import { chainOf3, createProject, hopHeader, mkWorker, newCard, openHop, setup } from "../helpers/api";
import { BP_PROJECT_2 } from "../helpers/fake-blueprint";

async function world() {
  const s = await setup();
  // a 204 has no body, which the shared `call` helper cannot read — so the DELETE goes through the app directly
  const del = async (id: string, actor: string | null = "operator") => {
    const res = await s.app.request(`/v1/workers/${id}`, { method: "DELETE", headers: actor === null ? {} : { "x-caw-actor": actor } });
    const text = await res.text();
    return { status: res.status, json: text === "" ? null : JSON.parse(text) };
  };
  const deletedEvents = async () => (await s.db.select().from(events).where(eq(events.type, "worker.deleted"))).map((e) => [e.actor, e.projectId, e.data]);
  const list = async () => (await s.call("GET", "/v1/workers")).json.workers as any[];
  const get = async (id: string) => (await list()).find((w) => w.id === id);
  return { ...s, del, deletedEvents, list, get };
}

test("DELETE a worker in no chain → 204, exactly one worker.deleted { id } by the operator; the worker stays in the list with deletedAt set; others stay live", async () => {
  const w = await world();
  const ann = await mkWorker(w.call, "Ann");
  const ben = await mkWorker(w.call, "Ben");
  expect((await w.get(ann.id)).deletedAt).toBeNull();
  const r = await w.del(ann.id);
  expect(r.status).toBe(204);
  expect(await w.deletedEvents()).toEqual([["operator", null, { id: ann.id }]]);
  const after = await w.get(ann.id);
  expect(after.deletedAt).toBeString();
  expect(Number.isNaN(Date.parse(after.deletedAt))).toBe(false);
  expect({ ...after, deletedAt: null }).toEqual(ann); // nothing else about them changed
  expect((await w.get(ben.id)).deletedAt).toBeNull();
});

test("DELETE a worker who is in chains → 409 worker_in_chain with the project ids (both), nothing written; after leaving the chains → 204", async () => {
  const w = await world();
  const ann = await mkWorker(w.call, "Ann");
  const p1 = (await createProject(w.call)).json;
  const p2 = (await w.call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT_2, version: 1 })).json; // a second Blueprint project (v1.15: one CAW project each)
  for (const p of [p1, p2]) await w.call("POST", `/v1/projects/${p.id}/chain/members`, { workerId: ann.id });
  const r = await w.del(ann.id);
  expect([r.status, r.json.error.code]).toEqual([409, "worker_in_chain"]);
  expect([...r.json.error.details.projectIds].sort()).toEqual([p1.id, p2.id].sort());
  expect(await w.deletedEvents()).toEqual([]);
  expect((await w.get(ann.id)).deletedAt).toBeNull();
  await w.call("DELETE", `/v1/projects/${p1.id}/chain/members/${ann.id}`);
  const still = await w.del(ann.id); // still in p2
  expect([still.status, still.json.error.details.projectIds]).toEqual([409, [p2.id]]);
  await w.call("DELETE", `/v1/projects/${p2.id}/chain/members/${ann.id}`);
  expect((await w.del(ann.id)).status).toBe(204);
});

test("DELETE an unknown id, a non-uuid id, or an already deleted worker → 404 (and no second event)", async () => {
  const w = await world();
  const ann = await mkWorker(w.call, "Ann");
  expect((await w.del("00000000-0000-4000-8000-000000000099")).status).toBe(404);
  expect((await w.del("not-a-uuid")).status).toBe(404);
  expect((await w.del(ann.id)).status).toBe(204);
  const again = await w.del(ann.id);
  expect([again.status, again.json.error.code]).toEqual([404, "not_found"]);
  expect(await w.deletedEvents()).toHaveLength(1);
});

test("DELETE as a worker → 403 operator_only; as a runner → 403 runner_not_allowed; no actor → 400 — nothing written", async () => {
  const w = await world();
  const ann = await mkWorker(w.call, "Ann");
  const ben = await mkWorker(w.call, "Ben");
  const asWorker = await w.del(ann.id, `worker:${ben.id}`);
  expect([asWorker.status, asWorker.json.error.code]).toEqual([403, "operator_only"]);
  expect((await w.del(ann.id, "runner:r1")).json.error.code).toBe("runner_not_allowed");
  expect((await w.del(ann.id, null)).status).toBe(400);
  expect(await w.deletedEvents()).toEqual([]);
  expect((await w.get(ann.id)).deletedAt).toBeNull();
});

test("a deleted worker is unknown to every write that names them: PATCH 404 · combine 404 (either side) · add to a chain 404 · a hand-off to them is a plain chain_broken, NOT recorded (like any unknown id)", async () => {
  const w = await world();
  const { project, a, b } = await chainOf3(w.call);
  await w.call("POST", `/v1/projects/${project.id}/chain/edges`, { from: a.id, to: b.id });
  const gone = await mkWorker(w.call, "Gone");
  const live = await mkWorker(w.call, "Live");
  expect((await w.del(gone.id)).status).toBe(204);

  expect((await w.call("PATCH", `/v1/workers/${gone.id}`, { name: "Back" })).status).toBe(404);
  expect((await w.get(gone.id)).name).toBe("Gone");
  for (const ids of [[gone.id, live.id], [live.id, gone.id]]) {
    const r = await w.call("POST", "/v1/workers/combine", { name: "Mix", workerIds: ids });
    expect([r.status, r.json.error.code]).toEqual([404, "not_found"]);
  }
  const add = await w.call("POST", `/v1/projects/${project.id}/chain/members`, { workerId: gone.id });
  expect([add.status, add.json.error.code]).toEqual([404, "not_found"]);

  // hand-off: Ann (a) holds a card in a running hop; the target is the deleted worker — and, as a control, a live worker that is off-chain
  const card = (await newCard(w.call, project.id, { assigneeId: a.id })).json;
  const hop = await openHop(w.call, project.id, card.id, a.id);
  const as = `worker:${a.id}`;
  const notes = async () => ((await w.call("GET", `/v1/cards/${card.id}/context`)).json.notes as any[]).filter((n) => n.type === "handoff_refused");
  const toGone = await w.call("POST", `/v1/cards/${card.id}/handoff`, { toWorkerId: gone.id, text: "ส่งต่อ" }, as, hopHeader(hop.id));
  expect([toGone.status, toGone.json.error.code]).toEqual([409, "chain_broken"]);
  expect(await notes()).toEqual([]); // not recorded: a deleted worker is unknown
  const toLive = await w.call("POST", `/v1/cards/${card.id}/handoff`, { toWorkerId: live.id, text: "ส่งต่อ" }, as, hopHeader(hop.id));
  expect(toLive.json.error.code).toBe("chain_broken");
  expect(await notes()).toHaveLength(1); // the control: a live worker's refused hand-off IS recorded (v1.3) — only the deleted one is skipped
});

test("name_taken counts LIVE workers only: a new worker may take a deleted worker's name (201); a live name is still 409; PATCH may rename onto a deleted name", async () => {
  const w = await world();
  const ann = await mkWorker(w.call, "Ann");
  const ben = await mkWorker(w.call, "Ben");
  expect((await w.call("POST", "/v1/workers", { name: "Ann", roles: ["BE"], skills: ["s"] })).json.error.code).toBe("name_taken");
  await w.del(ann.id);
  const again = await w.call("POST", "/v1/workers", { name: "Ann", roles: ["FE"], skills: ["s"] });
  expect([again.status, again.json.name]).toEqual([201, "Ann"]);
  expect(again.json.id).not.toBe(ann.id);
  expect((await w.call("POST", "/v1/workers", { name: "Ann", roles: ["QA"], skills: ["s"] })).json.error.code).toBe("name_taken"); // the new Ann is live
  await w.del(ben.id);
  const rename = await w.call("PATCH", `/v1/workers/${again.json.id}`, { name: "Ben" });
  expect([rename.status, rename.json.name]).toEqual([200, "Ben"]);
  expect((await w.list()).filter((x) => x.name === "Ann").map((x) => x.deletedAt !== null)).toEqual([true]); // the deleted Ann is still in the list
});

test("rebuild-check is same:true after create · delete · create again under the same name; the replay keeps deletedAt", async () => {
  const w = await world();
  const { project } = await chainOf3(w.call);
  const tmp = await mkWorker(w.call, "Tmp");
  await w.del(tmp.id);
  await mkWorker(w.call, "Tmp");
  expect((await w.call("POST", `/v1/projects/${project.id}/rebuild-check`)).json).toEqual({ same: true });
  const rebuilt = (await rebuild(w.db, project.id)).workers.filter((x) => x.name === "Tmp");
  expect(rebuilt.map((x) => x.deletedAt !== null).sort()).toEqual([false, true]);
});
