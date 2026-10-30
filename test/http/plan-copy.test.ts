// REQ-126 (SPEC-125 D4, TASK-168): a plan cannot be accepted twice. A copy of an accepted plan (same items: length, and per index the same trimmed title, anchor key and worker) is refused —
// 409 plan_already_accepted, nothing written. A plan with any item changed is a new plan.
import { expect, test } from "bun:test";
import { events } from "../../src/db/schema";
import { chatHop, chatWorld, hopHeader, postChat, setup } from "../helpers/api";

async function world() {
  const s = await setup();
  const chain = await chatWorld(s.call);
  const P = `/v1/projects/${chain.project.id}`;
  const msg = (await postChat(s.call, chain.project.id)).json;
  const hop = await chatHop(s.call, chain.project.id, msg.id, chain.a.id);
  const as = `worker:${chain.a.id}`;
  const H = hopHeader(hop.id);
  await s.call("POST", `${P}/locate`, { request: "ห้องใหญ่ต้องอนุมัติ" }, as, H); // finds DEC-001 STEP-003 STEP-004 STEP-005
  const item = (over: object = {}) => ({ title: "ทำหน้าอนุมัติ", todo: "ตาม STEP-004", anchor: { key: "STEP-004", version: 1 }, workerId: chain.b.id, dependsOn: [], hops: 2, ...over });
  const propose = async (items: object[]) => (await s.call("POST", `${P}/proposals`, { messageId: msg.id, items }, as, H)).json;
  const accept = (id: string) => s.call("POST", `/v1/proposals/${id}/accept`);
  const cardCount = async () => ((await s.call("GET", `${P}/cards`)).json.cards as unknown[]).length;
  const eventCount = async () => (await s.db.select().from(events)).length;
  return { ...s, ...chain, item, propose, accept, cardCount, eventCount };
}

test("accept A → 200; an open B with A's items → 409 plan_already_accepted (the PM's words), nothing written", async () => {
  const w = await world();
  const a = await w.propose([w.item(), w.item({ title: "ทำรายงาน", anchor: { key: "STEP-003", version: 1 } })]);
  expect((await w.accept(a.id)).status).toBe(200);
  const b = await w.propose([w.item(), w.item({ title: "ทำรายงาน", anchor: { key: "STEP-003", version: 1 } })]); // the copy
  const cards = await w.cardCount();
  const events0 = await w.eventCount();
  const r = await w.accept(b.id);
  expect([r.status, r.json.error.code, r.json.error.message]).toEqual([409, "plan_already_accepted", "แผนนี้ตกลงไปแล้ว"]);
  expect(await w.cardCount()).toBe(cards);
  expect(await w.eventCount()).toBe(events0);
  expect((await w.call("GET", `/v1/projects/${w.project.id}/proposals`)).json.proposals.find((p: any) => p.id === b.id).status).toBe("open"); // B stays open, untouched
});

test("B with one title changed → 200 (a new plan); titles are compared trimmed", async () => {
  const w = await world();
  const a = await w.propose([w.item({ title: "ทำหน้าอนุมัติ" })]);
  expect((await w.accept(a.id)).status).toBe(200);
  const spaced = await w.propose([w.item({ title: "  ทำหน้าอนุมัติ  " })]);
  expect((await w.accept(spaced.id)).json.error.code).toBe("plan_already_accepted"); // only whitespace differs: the same plan
  const changed = await w.propose([w.item({ title: "ทำหน้าอนุมัติ (แก้)" })]);
  expect((await w.accept(changed.id)).status).toBe(200);
});

test("a different anchor, a different worker, or a different number of items is a different plan", async () => {
  const w = await world();
  const a = await w.propose([w.item()]);
  expect((await w.accept(a.id)).status).toBe(200);
  const otherAnchor = await w.propose([w.item({ anchor: { key: "STEP-003", version: 1 } })]);
  expect((await w.accept(otherAnchor.id)).status).toBe(200);
  const otherWorker = await w.propose([w.item({ workerId: w.c.id })]);
  expect((await w.accept(otherWorker.id)).status).toBe(200);
  const moreItems = await w.propose([w.item(), w.item({ title: "อีกงาน", anchor: { key: "STEP-005", version: 1 } })]);
  expect((await w.accept(moreItems.id)).status).toBe(200);
});

test("a plan that was never accepted blocks nothing: two OPEN copies, the first accepted → the second is refused only after that", async () => {
  const w = await world();
  const a = await w.propose([w.item()]);
  const b = await w.propose([w.item()]);
  // proposing again on the same message supersedes the older open one, so only b can be accepted — the point: an unaccepted plan is no reason to refuse
  expect((await w.accept(b.id)).status).toBe(200);
  expect((await w.accept(a.id)).json.error.code).not.toBe("plan_already_accepted"); // superseded → not_open, as before
});
