// TASK-A-079 / contract v1.4 + v1.6 (REQ-013): proposals of cards from the entry worker's chat hop, and the operator's accept.
// Anchors are checked against Blueprint (the fake serves RECORDED answers); a proposal may anchor only on keys its hop LOCATED (v1.6).
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
  const locate = (request = "ห้องใหญ่ต้องอนุมัติ") => s.call("POST", `${P}/locate`, { request }, as, H); // finds DEC-001 STEP-003 STEP-004 STEP-005
  const item = (over: object = {}) => ({ title: "ทำหน้าอนุมัติ", todo: "ตาม STEP-004", anchor: { key: "STEP-004", version: 1 }, workerId: chain.b.id, dependsOn: [], hops: 2, ...over });
  const propose = (items: object[], extra: object = {}, actor = as, headers: Record<string, string> = H) =>
    s.call("POST", `${P}/proposals`, { messageId: msg.id, items, ...extra }, actor, headers);
  return { ...s, ...chain, P, msg, hop, as, H, locate, item, propose };
}

test("propose (v1.6): only keys the hop located — a hop with no locate yet is refused for every item; the refusal lists the keys not located; nothing written", async () => {
  const w = await world();
  const n = async () => (await w.db.select().from(events)).length;
  const before = await n();
  const none = await w.propose([w.item(), w.item({ anchor: { key: "STEP-003", version: 1 } })]);
  expect([none.status, none.json.error.code, none.json.error.details]).toEqual([422, "anchor_not_located", { keys: ["STEP-004", "STEP-003"] }]);
  expect(await n()).toBe(before);

  await w.locate(); // DEC-001, STEP-003, STEP-004, STEP-005
  const afterLocate = await n();
  const partly = await w.propose([w.item(), w.item({ anchor: { key: "STEP-001", version: 1 } }), w.item({ anchor: { key: "STEP-002", version: 1 } })]);
  expect([partly.status, partly.json.error.code, partly.json.error.details]).toEqual([422, "anchor_not_located", { keys: ["STEP-001", "STEP-002"] }]);
  expect(await n()).toBe(afterLocate); // the refusal wrote nothing (the locate itself wrote one hop.located)
});

test("locate, then propose on a located key at the version LOCATE returned → 201 (the case Team C hit: DEC-001 @ the latest confirmed version)", async () => {
  const w = await world();
  const located = await w.locate();
  expect(located.status).toBe(200);
  const version = located.json.version as number; // read from the locate answer — never hard-coded
  expect(located.json.candidates.map((c: any) => c.key)).toContain("DEC-001");
  const r = await w.propose([w.item({ title: "กฎห้องใหญ่", anchor: { key: "DEC-001", version } })]);
  expect([r.status, r.json.error]).toEqual([201, undefined]);
  expect(r.json.items[0].anchor).toEqual({ key: "DEC-001", version });
});

test("locate twice → the hop's locatedKeys is the UNION (order kept, no repeats); only keys, no spec text", async () => {
  const w = await world();
  expect((await w.locate("ห้องใหญ่ต้องอนุมัติ")).status).toBe(200);
  const k1 = (await w.call("GET", `${w.P}/hops?limit=1`)).json.hops[0].locatedKeys;
  expect(k1).toEqual(["DEC-001", "STEP-003", "STEP-004", "STEP-005"]);
  expect((await w.locate("ค้นหาห้องว่าง")).status).toBe(200); // API-001 INT-002 INT-003 SCR-001
  expect((await w.call("GET", `${w.P}/hops?limit=1`)).json.hops[0].locatedKeys).toEqual(["DEC-001", "STEP-003", "STEP-004", "STEP-005", "API-001", "INT-002", "INT-003", "SCR-001"]);
  expect((await w.locate("ห้องใหญ่ต้องอนุมัติ")).status).toBe(200); // the same again adds nothing
  expect((await w.call("GET", `${w.P}/hops?limit=1`)).json.hops[0].locatedKeys).toHaveLength(8);
  expect((await w.locate("xyzzy plugh")).json).toMatchObject({ notInSpec: true, candidates: [] }); // nothing found: keys unchanged
  expect((await w.call("GET", `${w.P}/hops?limit=1`)).json.hops[0].locatedKeys).toHaveLength(8);
});

test("propose: 201 Proposal (2 items, one depends on the other); hopsTotal computed; an older open one on the same message is superseded in the same event", async () => {
  const w = await world();
  await w.locate();
  const first = await w.propose([w.item({ hops: 2 }), w.item({ title: "ทดสอบ", anchor: { key: "STEP-003", version: 1 }, dependsOn: [0], hops: 3 })]);
  expect(first.status).toBe(201);
  expect(first.json).toEqual({
    id: first.json.id, projectId: w.project.id, messageId: w.msg.id, version: 1, status: "open", cardIds: null, hopsTotal: 5, createdAt: first.json.createdAt,
    items: [w.item({ hops: 2 }), w.item({ title: "ทดสอบ", anchor: { key: "STEP-003", version: 1 }, dependsOn: [0], hops: 3 })],
  });
  const second = await w.propose([w.item({ hops: 1 })]);
  expect(second.status).toBe(201);
  const list = (await w.call("GET", `${w.P}/proposals`)).json.proposals;
  expect(list.map((p: any) => [p.id, p.status, p.hopsTotal])).toEqual([[second.json.id, "open", 1], [first.json.id, "superseded", 5]]); // newest first
  expect((await w.call("GET", `${w.P}/proposals?messageId=${w.msg.id}`)).json.proposals).toHaveLength(2);
  expect((await w.call("GET", `${w.P}/proposals?messageId=00000000-0000-0000-0000-000000000099`)).json.proposals).toEqual([]);
  const evs = (await w.db.select().from(events)).filter((e) => e.type === "proposal.made");
  expect(evs).toHaveLength(2); // the superseding is INSIDE the second event, not an event of its own
  expect((evs[1]!.data as { supersedes: string[] }).supersedes).toEqual([first.json.id]);
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
});

test("propose errors: validation 400 · not a chain member 400 · bad dependsOn (index out of range, itself, a cycle) 400 · a worker's chat hop is required (400 / 403) · 422 anchor_not_in_version · 502", async () => {
  const w = await world();
  await w.locate();
  const bad = async (items: object[]) => (await w.propose(items)).status;
  expect(await bad([])).toBe(400);
  expect(await bad(Array.from({ length: 51 }, () => w.item()))).toBe(400);
  expect(await bad([w.item({ title: "" })])).toBe(400);
  expect(await bad([w.item({ hops: 0 })])).toBe(400);
  expect(await bad([w.item({ anchor: { key: "STEP-004" } })])).toBe(400);
  const stranger = (await w.call("POST", "/v1/workers", { name: "Zed", role: "BE", skills: ["x"] })).json;
  const nm = await w.propose([w.item({ workerId: stranger.id })]);
  expect([nm.status, nm.json.error.code]).toEqual([400, "not_a_member"]);
  expect(await bad([w.item({ dependsOn: [1] })])).toBe(400); // out of range
  expect(await bad([w.item({ dependsOn: [0] })])).toBe(400); // itself
  expect(await bad([w.item({ dependsOn: [1] }), w.item({ dependsOn: [0] })])).toBe(400); // a cycle
  expect(await bad([w.item({ dependsOn: [1] }), w.item({ dependsOn: [2] }), w.item({ dependsOn: [0] })])).toBe(400); // a longer cycle
  expect(await bad([w.item({ dependsOn: [1, 1] }), w.item()])).toBe(400); // twice the same index

  const noHeader = await w.propose([w.item()], {}, w.as, {});
  expect([noHeader.status, noHeader.json.error.code]).toEqual([400, "hop_required"]);
  const op = await w.propose([w.item()], {}, "operator", {});
  expect([op.status, op.json.error.code]).toEqual([403, "not_your_message"]);
  const ben = await w.propose([w.item()], {}, `worker:${w.b.id}`, w.H);
  expect([ben.status, ben.json.error.code]).toEqual([403, "not_your_message"]);
  const otherMsg = (await postChat(w.call, w.project.id, "ข้อความอื่น")).json;
  const wrong = await w.call("POST", `${w.P}/proposals`, { messageId: otherMsg.id, items: [w.item()] }, w.as, w.H); // her hop is on the first message
  expect([wrong.status, wrong.json.error.code]).toEqual([403, "not_your_message"]);

  const gone = await w.propose([w.item({ anchor: { key: "STEP-004", version: 9 } })]);
  expect([gone.status, gone.json.error.code]).toEqual([422, "version_not_confirmed"]);
  await w.call("POST", `${w.P}/locate`, { request: "ห้องใหญ่ต้องอนุมัติ" }, w.as, w.H);
  w.fake.mode.gone.add("STEP-005"); // located, then removed from Blueprint (STEP-005 is a real part of v3: without this the call is accepted)
  const stale = await w.propose([w.item({ anchor: { key: "STEP-005", version: 3 } })]);
  expect([stale.status, stale.json.error.code]).toEqual([422, "anchor_not_in_version"]);
  w.fake.mode.down = true;
  const down = await w.propose([w.item()]);
  expect([down.status, down.json.error.code]).toEqual([502, "blueprint_unreachable"]);
  expect((await w.call("GET", `${w.P}/proposals`)).json.proposals).toEqual([]); // none of the refused ones wrote a proposal
});

test("accept: the operator → 200 { cards } — one card per item, dependencies mapped from indexes to the new ids, assignee = workerId, the proposal `accepted` with its cardIds; one transaction", async () => {
  const w = await world();
  await w.locate();
  const p = (await w.propose([
    w.item({ title: "หน้าอนุมัติ", dependsOn: [1] }), // depends on the SECOND item: a dependency on a card created after it
    w.item({ title: "ปุ่มอนุมัติ", anchor: { key: "STEP-003", version: 1 }, workerId: w.c.id, dependsOn: [] }),
  ])).json;
  const before = (await w.call("GET", `${w.P}/cards`)).json.cards.length;
  const r = await w.call("POST", `/v1/proposals/${p.id}/accept`);
  expect(r.status).toBe(200);
  const cards = r.json.cards;
  expect(cards.map((c: any) => [c.number, c.title, c.assigneeId, c.anchor, c.status])).toEqual([
    [1, "หน้าอนุมัติ", w.b.id, { key: "STEP-004", version: 1 }, "todo"], [2, "ปุ่มอนุมัติ", w.c.id, { key: "STEP-003", version: 1 }, "todo"],
  ]);
  expect(cards[0].dependsOn).toEqual([cards[1].id]); // index 1 → the second new card
  expect(cards[1].dependsOn).toEqual([]);
  expect(cards.map((c: any) => c.workable)).toEqual([false, true]); // the first waits for the second
  expect((await w.call("GET", `${w.P}/cards`)).json.cards.length).toBe(before + 2);
  const after = (await w.call("GET", `${w.P}/proposals`)).json.proposals[0];
  expect([after.status, after.cardIds]).toEqual(["accepted", cards.map((c: any) => c.id)]);
  const evs = (await w.db.select().from(events)).map((e) => e.type);
  expect(evs.filter((t) => t === "card.created")).toHaveLength(2);
  expect(evs.at(-1)).toBe("proposal.accepted"); // the cards, then the acceptance, together
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
});

test("accept errors: a worker 403 operator_only · a runner refused · unknown 404 · Blueprint down 502 · an anchor gone in Blueprint → 422 and NOTHING written — then it goes through once it is back", async () => {
  const w = await world();
  await w.locate();
  const p = (await w.propose([w.item(), w.item({ anchor: { key: "STEP-003", version: 1 }, dependsOn: [0] })])).json;
  const A = `/v1/proposals/${p.id}/accept`;
  expect((await w.call("POST", A, undefined, w.as, w.H)).json.error.code).toBe("operator_only");
  expect((await w.call("POST", A, undefined, "runner:r-1")).json.error.code).toBe("runner_not_allowed");
  expect((await w.call("POST", "/v1/proposals/00000000-0000-0000-0000-000000000099/accept")).status).toBe(404);
  expect((await w.call("POST", "/v1/proposals/not-a-uuid/accept")).status).toBe(404);

  const n = async () => (await w.db.select().from(events)).length;
  const before = await n();
  w.fake.mode.down = true;
  const down = await w.call("POST", A);
  expect([down.status, down.json.error.code]).toEqual([502, "blueprint_unreachable"]);
  w.fake.mode.down = false;
  w.fake.mode.gone.add("STEP-003"); // the part was removed in Blueprint since the proposal was made
  const r = await w.call("POST", A);
  expect([r.status, r.json.error.code]).toEqual([422, "anchor_not_in_version"]);
  expect(await n()).toBe(before);
  expect((await w.call("GET", `${w.P}/cards`)).json.cards).toEqual([]);
  expect((await w.call("GET", `${w.P}/proposals`)).json.proposals[0].status).toBe("open"); // still open
  w.fake.mode.gone.delete("STEP-003");
  expect((await w.call("POST", A)).status).toBe(200);
});

test("accept: a superseded proposal is not open (409 not_open)", async () => {
  const w = await world();
  await w.locate();
  const first = (await w.propose([w.item()])).json;
  await w.propose([w.item({ hops: 4 })]); // supersedes the first
  const r = await w.call("POST", `/v1/proposals/${first.id}/accept`);
  expect([r.status, r.json.error.code]).toEqual([409, "not_open"]);
});

test("accept: a second accept → 409 not_open; a worker removed from the chain since the proposal → 400 not_a_member, nothing written", async () => {
  const w = await world();
  await w.locate();
  const p1 = (await w.propose([w.item()])).json;
  expect((await w.call("POST", `/v1/proposals/${p1.id}/accept`)).status).toBe(200);
  const again = await w.call("POST", `/v1/proposals/${p1.id}/accept`);
  expect([again.status, again.json.error.code]).toEqual([409, "not_open"]);

  const p2 = (await w.propose([w.item({ workerId: w.c.id })])).json;
  await w.call("DELETE", `${w.P}/chain/members/${w.c.id}`); // Cat has no open cards: removable
  const n = (await w.db.select().from(events)).length;
  const r = await w.call("POST", `/v1/proposals/${p2.id}/accept`);
  expect([r.status, r.json.error.code]).toEqual([400, "not_a_member"]);
  expect((await w.db.select().from(events)).length).toBe(n);
  void hopHeader;
});
