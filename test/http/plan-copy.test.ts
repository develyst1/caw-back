// REQ-126 (SPEC-125 D4, TASK-168; round 2 SPEC-126 D1/D2, TASK-170): a later plan adds only the work that is not already open on the board. "On the board" = a live work card (not done, its part still in the spec)
// holds the item's spec part (anchor KEY — never the wording, the worker or the grouping). All items on the board → 409 plan_already_accepted, nothing written (an identical copy is one case);
// some → cards for the others only; `Proposal.onBoard` says which, on read. A card that is done, or whose part has left the spec, no longer counts.
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

test("B with one title changed → 409 (round 2: same key, other words = the same work, TEST-122 DEF-2); titles trimmed or reworded are all the same work", async () => {
  const w = await world();
  const a = await w.propose([w.item({ title: "ทำหน้าอนุมัติ" })]);
  expect((await w.accept(a.id)).status).toBe(200);
  const spaced = await w.propose([w.item({ title: "  ทำหน้าอนุมัติ  " })]);
  expect((await w.accept(spaced.id)).json.error.code).toBe("plan_already_accepted"); // only whitespace differs
  const changed = await w.propose([w.item({ title: "ทำหน้าอนุมัติ (แก้)" })]);
  const cards = await w.cardCount();
  const r = await w.accept(changed.id);
  expect([r.status, r.json.error.code]).toEqual([409, "plan_already_accepted"]); // the words changed, the part did not
  expect(await w.cardCount()).toBe(cards);
});

test("another part → 200 (1 card); another worker on the SAME part → 409 (key only); the same item plus one new part → 200 with exactly 1 new card, on that part", async () => {
  const w = await world();
  const a = await w.propose([w.item()]);
  expect((await w.accept(a.id)).status).toBe(200);
  const otherAnchor = await w.propose([w.item({ anchor: { key: "STEP-003", version: 1 } })]);
  const r1 = await w.accept(otherAnchor.id);
  expect([r1.status, r1.json.cards.length]).toEqual([200, 1]);
  const otherWorker = await w.propose([w.item({ workerId: w.c.id })]); // STEP-004 again, another worker: the part is on the board
  expect((await w.accept(otherWorker.id)).json.error.code).toBe("plan_already_accepted");
  const before = await w.cardCount();
  const plusOne = await w.propose([w.item(), w.item({ title: "อีกงาน", anchor: { key: "STEP-005", version: 1 } })]);
  const r2 = await w.accept(plusOne.id);
  expect(r2.status).toBe(200);
  expect(r2.json.cards).toHaveLength(1);
  expect(r2.json.cards[0].anchor.key).toBe("STEP-005");
  expect(await w.cardCount()).toBe(before + 1);
});

test("a plan that was never accepted blocks nothing: two OPEN copies, the first accepted → the second is refused only after that", async () => {
  const w = await world();
  const a = await w.propose([w.item()]);
  const b = await w.propose([w.item()]);
  // proposing again on the same message supersedes the older open one, so only b can be accepted — the point: an unaccepted plan is no reason to refuse
  expect((await w.accept(b.id)).status).toBe(200);
  expect((await w.accept(a.id)).json.error.code).not.toBe("plan_already_accepted"); // superseded → not_open, as before
});

// ---- REQ-126 round 2 (SPEC-126 D1/D2, TASK-170) ----
const listOf = async (w: Awaited<ReturnType<typeof world>>) => (await w.call("GET", `/v1/projects/${w.project.id}/proposals`)).json.proposals as { id: string; status: string; onBoard: number[]; cardIds: string[] | null }[];

type PlanItem = { title: string; todo: string; key: string; role: "BE" | "FE" | "QA"; dependsOn: number[]; hops: number };
type Plan = PlanItem[];
// AC-7, word for word: TEST-122 round 2 — `FIRST` is the plan the owner accepted (9 cards); `SECOND` is the reworded repost the entry worker made after that (same 9 parts but REQ-009 swapped for a second REQ-004, other titles, other grouping)
const FIRST: Plan = [
  { title: "ตั้ง server ที่ 127.0.0.1:3930", todo: "ทำ server ที่รันที่ http://127.0.0.1:3930 เสิร์ฟหน้าเว็บหน้าเดียว ไม่ต้อง login ไม่มีฐานข้อมูล บอกคำสั่งรันให้ชัด", key: "REQ-009", role: "BE", dependsOn: [], hops: 1 },
  { title: "เก็บข้อมูลในไฟล์ JSON + API หนังสือ", todo: "เก็บรายการหนังสือในไฟล์ JSON บนเครื่อง (ชื่อ, ผู้แต่ง, สถานะ, ชื่อคนยืม, วันที่ยืม) ทำ API: ดูรายการ, เพิ่มหนังสือ, ยืม (บันทึกชื่อคนยืม+วันที่), คืน (กลับเป็นว่าง) ปิดเปิด server ใหม่ข้อมูลต้องอยู่ครบ", key: "REQ-007", role: "BE", dependsOn: [0], hops: 2 },
  { title: "ตรวจห้ามว่างฝั่ง server", todo: "ชื่อหนังสือและชื่อคนยืมห้ามว่าง (รวมเว้นวรรคล้วน) ถ้าว่างตอบ error พร้อมข้อความภาษาไทย และไม่บันทึกลงไฟล์", key: "REQ-008", role: "BE", dependsOn: [1], hops: 1 },
  { title: "หน้ารายการหนังสือพร้อมสถานะ", todo: "หน้าเว็บภาษาไทยทั้งหมด แสดงหนังสือทุกเล่ม พร้อมสถานะ \"ว่าง\" หรือ \"ถูกยืม\" ชื่อคนยืม และวันที่ยืม ดึงข้อมูลจาก API", key: "REQ-003", role: "FE", dependsOn: [1], hops: 2 },
  { title: "ฟอร์มเพิ่มหนังสือ", todo: "ช่องชื่อหนังสือ, ผู้แต่ง และปุ่ม \"เพิ่มหนังสือ\" เพิ่มแล้วรายการอัปเดต ถ้าชื่อว่างขึ้นข้อความไทยและไม่บันทึก", key: "REQ-002", role: "FE", dependsOn: [2, 3], hops: 1 },
  { title: "ปุ่มยืม", todo: "ปุ่ม \"ยืม\" ที่หนังสือที่ว่าง ใส่ชื่อคนยืม แล้วเปลี่ยนเป็นถูกยืมพร้อมวันที่ยืม ถ้าชื่อว่างขึ้นข้อความไทยและไม่บันทึก", key: "REQ-004", role: "FE", dependsOn: [2, 3], hops: 1 },
  { title: "ปุ่มคืน พร้อมถามยืนยัน", todo: "ปุ่ม \"คืน\" ที่หนังสือที่ถูกยืม ถามยืนยันเป็นภาษาไทยก่อน ยืนยันแล้วกลับเป็นว่าง ยกเลิกแล้วไม่เปลี่ยน", key: "REQ-005", role: "FE", dependsOn: [3], hops: 1 },
  { title: "ช่องค้นหา", todo: "ช่องค้นหาจากชื่อหนังสือหรือผู้แต่ง พิมพ์แล้วรายการกรองทันที ไม่ต้องกดปุ่ม", key: "REQ-006", role: "FE", dependsOn: [3], hops: 1 },
  { title: "ทดสอบทั้งระบบตาม spec", todo: "ทดสอบครบทุกข้อ: เพิ่ม, รายการ/สถานะ, ยืม, คืน (ถามยืนยัน), ค้นหา, ห้ามว่าง, ปิดเปิด server ข้อมูลยังอยู่, รันที่ 127.0.0.1:3930, ข้อความไทยทั้งหมด และไม่มีของที่อยู่ในรายการไม่ทำ", key: "REQ-001", role: "QA", dependsOn: [0, 1, 2, 3, 4, 5, 6, 7], hops: 2 },
];
const SECOND: Plan = [
  { title: "ตั้ง server ที่ 127.0.0.1:3930 และเก็บข้อมูลในไฟล์ JSON", todo: "ตั้ง server รันที่ http://127.0.0.1:3930 ไม่มี login ไม่มีฐานข้อมูล เก็บข้อมูลหนังสือในไฟล์ JSON บนเครื่อง ปิดแล้วเปิด server ใหม่ข้อมูลต้องอยู่ครบ (หนังสือ: ชื่อ, ผู้แต่ง (ว่างได้), สถานะ, ชื่อคนยืม, วันที่ยืม)", key: "REQ-007", role: "BE", dependsOn: [], hops: 2 },
  { title: "API เพิ่ม / ดูรายการ / ยืม / คืน หนังสือ", todo: "ทำ API: ดูรายการทั้งหมด, เพิ่มหนังสือ (ผู้แต่งไม่บังคับ ปล่อยว่างได้), ยืม (ได้เฉพาะเล่มที่ว่าง บันทึกชื่อคนยืมและวันที่ยืม), คืน (ได้เฉพาะเล่มที่ถูกยืม แล้วกลับเป็นว่าง ล้างชื่อคนยืมและวันที่)", key: "REQ-004", role: "BE", dependsOn: [0], hops: 2 },
  { title: "ตรวจห้ามว่างฝั่ง server", todo: "ชื่อหนังสือและชื่อคนยืมห้ามว่าง (ตัดช่องว่างก่อนตรวจ) ถ้าว่างให้ตอบข้อความภาษาไทยและไม่บันทึก ผู้แต่งไม่ต้องตรวจ", key: "REQ-008", role: "BE", dependsOn: [1], hops: 1 },
  { title: "หน้ารายการหนังสือพร้อมสถานะ", todo: "เว็บหน้าเดียว แสดงหนังสือทั้งหมด: ชื่อ, ผู้แต่ง, สถานะ \"ว่าง\"/\"ถูกยืม\", ชื่อคนยืม และวันที่ยืมแบบไทยไม่มีเวลา เช่น 31 ต.ค. 2569 (เล่มที่ว่างไม่แสดงวันที่) ข้อความทั้งหมดเป็นภาษาไทย", key: "REQ-003", role: "FE", dependsOn: [1], hops: 1 },
  { title: "ฟอร์มเพิ่มหนังสือ", todo: "ช่องชื่อหนังสือ, ผู้แต่ง (ไม่บังคับ) และปุ่ม \"เพิ่มหนังสือ\" ถ้าชื่อหนังสือว่างให้ขึ้นข้อความภาษาไทยและไม่บันทึก เพิ่มแล้วรายการอัปเดตทันที", key: "REQ-002", role: "FE", dependsOn: [2, 3], hops: 1 },
  { title: "ปุ่มยืม", todo: "ปุ่ม \"ยืม\" ที่เล่มที่ว่าง ให้ใส่ชื่อคนยืม ถ้าว่างขึ้นข้อความภาษาไทยและไม่บันทึก ยืมแล้วเปลี่ยนเป็นถูกยืม พร้อมวันที่ยืมแบบไทย", key: "REQ-004", role: "FE", dependsOn: [2, 3], hops: 1 },
  { title: "ปุ่มคืนแบบถามยืนยัน", todo: "ปุ่ม \"คืน\" ที่เล่มที่ถูกยืม ถามยืนยันเป็นภาษาไทยก่อน ถ้ายืนยันแล้วกลับเป็นว่าง ถ้ายกเลิกไม่เปลี่ยนอะไร", key: "REQ-005", role: "FE", dependsOn: [3], hops: 1 },
  { title: "ช่องค้นหา", todo: "ช่องค้นหาจากชื่อหรือผู้แต่ง พิมพ์แล้วรายการกรองทันที ไม่ต้องกดปุ่ม", key: "REQ-006", role: "FE", dependsOn: [3], hops: 1 },
  { title: "ทดสอบทั้งระบบตาม spec", todo: "ทดสอบทุกข้อใน spec: เพิ่ม (ผู้แต่งว่างได้), รายการและสถานะ, ยืม (วันที่แบบไทย เช่น 31 ต.ค. 2569), คืนแบบยืนยัน, ค้นหา, ข้อมูลอยู่ครบหลังรีสตาร์ต server, ห้ามว่าง, รันที่ 127.0.0.1:3930 ข้อความไทยทั้งหมด และเช็กว่าไม่มีของในรายการ \"ไม่ทำ\"", key: "REQ-001", role: "QA", dependsOn: [0, 1, 2, 3, 4, 5, 6, 7], hops: 2 },
];

test("AC-7 (TEST-122 round 2, word for word): after the 9-card plan is accepted, the reworded repost lists onBoard [0…8] and accepting it → 409 plan_already_accepted — still 9 cards, no event written", async () => {
  const w = await world();
  for (let n = 1; n <= 9; n++) w.fake.mode.extraParts[`REQ-00${n}`] = { kind: "requirement", title: `ข้อกำหนด ${n}`, body: { text: `ข้อกำหนดที่ ${n}` } };
  const who = { BE: w.a.id, FE: w.b.id, QA: w.c.id };
  const items = (plan: Plan) => plan.map((x) => ({ title: x.title, todo: x.todo, anchor: { key: x.key, version: 0 }, workerId: who[x.role], dependsOn: x.dependsOn, hops: x.hops }));
  const first = await w.propose(items(FIRST));
  expect(first.items).toHaveLength(9);
  const accepted = await w.accept(first.id);
  expect([accepted.status, accepted.json.cards.length]).toEqual([200, 9]);
  const second = await w.propose(items(SECOND));
  expect(second.onBoard).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const cards = await w.cardCount();
  const events0 = await w.eventCount();
  const r = await w.accept(second.id);
  expect([r.status, r.json.error.code, r.json.error.message]).toEqual([409, "plan_already_accepted", "แผนนี้ตกลงไปแล้ว"]);
  expect(cards).toBe(9);
  expect(await w.cardCount()).toBe(9);
  expect(await w.eventCount()).toBe(events0);
});

test("AC-8: a plan [STEP-004 reworded, a new STEP-005 that depends on it] → onBoard [0]; accepting makes exactly 1 card (STEP-005) whose dependsOn is the STEP-004 card of the first plan; the proposal's cardIds has that 1 id", async () => {
  const w = await world();
  const a = await w.propose([w.item({ title: "ทำหน้าอนุมัติ" })]);
  const first = await w.accept(a.id);
  const step4 = first.json.cards[0];
  const b = await w.propose([w.item({ title: "ทำหน้าอนุมัติ — เขียนใหม่" }), w.item({ title: "ทำรายงาน", anchor: { key: "STEP-005", version: 1 }, dependsOn: [0] })]);
  expect(b.onBoard).toEqual([0]);
  const r = await w.accept(b.id);
  expect(r.status).toBe(200);
  expect(r.json.cards).toHaveLength(1);
  expect(r.json.cards[0]).toMatchObject({ anchor: { key: "STEP-005" }, dependsOn: [step4.id], number: step4.number + 1 }); // consecutive numbers: only the new card takes one
  expect((await listOf(w)).find((p) => p.id === b.id)).toMatchObject({ status: "accepted", cardIds: [r.json.cards[0].id], onBoard: [] });
  expect((await w.call("POST", `/v1/projects/${w.project.id}/rebuild-check`)).json).toEqual({ same: true });
});

test("a card that is DONE no longer holds its part (Q2 C): propose STEP-004 again → onBoard [] and accepting makes 1 new card", async () => {
  const w = await world();
  const a = await w.propose([w.item()]);
  const card = (await w.accept(a.id)).json.cards[0];
  expect((await w.call("PATCH", `/v1/cards/${card.id}/status`, { status: "done" })).status).toBe(200); // the operator
  const again = await w.propose([w.item()]);
  expect(again.onBoard).toEqual([]);
  const r = await w.accept(again.id);
  expect([r.status, r.json.cards.length]).toEqual([200, 1]);
});

test("a part that has LEFT the spec no longer holds its part (3d, read side): the open plan's onBoard goes from [0] to []", async () => {
  const w = await world();
  const a = await w.propose([w.item()]);
  expect((await w.accept(a.id)).status).toBe(200);
  const again = await w.propose([w.item()]);
  expect((await listOf(w)).find((p) => p.id === again.id)!.onBoard).toEqual([0]);
  w.fake.mode.changes.push({ rev: 2, at: "2026-10-29T07:00:00.000Z", by: "โด่ง", cause: "edit", added: [], changed: [], removed: ["STEP-004"] });
  w.fake.mode.spec.revision = 2;
  w.fake.mode.gone.add("STEP-004");
  await w.follow.pullAll();
  expect((await listOf(w)).find((p) => p.id === again.id)!.onBoard).toEqual([]);
});

test("read side: GET …/proposals — an OPEN plan carries onBoard (which items are on the board), an accepted or superseded one carries []", async () => {
  const w = await world();
  const a = await w.propose([w.item()]);
  expect((await listOf(w)).find((p) => p.id === a.id)!.onBoard).toEqual([]); // nothing on the board yet
  expect((await w.accept(a.id)).status).toBe(200);
  const open = await w.propose([w.item({ title: "อีกที" }), w.item({ title: "ทำรายงาน", anchor: { key: "STEP-003", version: 1 } })]);
  const list = await listOf(w);
  expect(list.find((p) => p.id === open.id)!.onBoard).toEqual([0]);
  expect(list.find((p) => p.id === a.id)).toMatchObject({ status: "accepted", onBoard: [] }); // accepted: [] whatever is on the board
  const superseding = await w.propose([w.item({ title: "อีกที" })]);
  const after = await listOf(w);
  expect(after.find((p) => p.id === open.id)).toMatchObject({ status: "superseded", onBoard: [] });
  expect(after.find((p) => p.id === superseding.id)!.onBoard).toEqual([0]);
});
