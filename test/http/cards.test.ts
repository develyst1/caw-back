// TASK-A-072: cards with anchors (AC-2), card context (AC-3), comments + hand-offs (AC-4), status, assignee,
// question cards (AC-7), spec-change clear — each rule the SPEC names, with the actor rule on top.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { chainOf3, hopHeader, newCard, openHop, setup } from "../helpers/api";

const fix = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/blueprint/${name}.json`, import.meta.url), "utf8"));
const as = (w: { id: string }) => `worker:${w.id}`;

// was: "…a key not in v1 → 422 anchor_not_in_version · an unconfirmed version → 422 version_not_confirmed". REQ-105 (D2/D4): the key is checked against the CURRENT spec; a `version` in the body is ignored (no 422 any more).
test("AC-2 anchor: no anchor → 400 anchor_required · a key not in the current spec → 422 anchor_not_in_version · a `version` Blueprint never confirmed is ignored (the card is cut at the current label)", async () => {
  const { call } = await setup();
  const { project } = await chainOf3(call);
  const P = `/v1/projects/${project.id}/cards`;
  const none = await call("POST", P, { title: "ไม่มี anchor", todo: "x" });
  expect([none.status, none.json.error.code]).toEqual([400, "anchor_required"]);
  expect((await call("POST", P, { title: "", todo: "x", anchor: { key: "STEP-004", version: 1 } })).status).toBe(400);
  expect((await call("POST", P, { title: "x".repeat(201), todo: "x", anchor: { key: "STEP-004", version: 1 } })).status).toBe(400);
  expect((await call("POST", P, { title: "t", todo: "x".repeat(8001), anchor: { key: "STEP-004", version: 1 } })).status).toBe(400);
  const nokey = await newCard(call, project.id, { anchor: { key: "NOPE-999", version: 1 } });
  expect([nokey.status, nokey.json.error.code]).toEqual([422, "anchor_not_in_version"]);
  expect((await call("GET", `/v1/projects/${project.id}/cards`)).json.cards).toEqual([]); // the refused ones wrote nothing
  const nov = await newCard(call, project.id, { anchor: { key: "STEP-004", version: 9 } }); // was 422 version_not_confirmed
  expect([nov.status, nov.json.anchor, nov.json.anchorLabel]).toEqual([201, { key: "STEP-004", version: 1 }, "v1"]);
});

test("POST cards: 201 Card (number from 1, todo, workable, anchor) · assignee must be a member · operator only · Blueprint down → 502", async () => {
  const { call, fake } = await setup();
  const { project, a } = await chainOf3(call);
  const r = await newCard(call, project.id, { assigneeId: a.id });
  expect(r.status).toBe(201);
  expect(r.json).toMatchObject({
    projectId: project.id, number: 1, kind: "work", title: "ทำหน้าอนุมัติ", todo: "ทำตาม STEP-004", status: "todo", assigneeId: a.id,
    anchor: { key: "STEP-004", version: 1 }, anchorLabel: "v1", specChangedVersion: null, dependsOn: [], question: null, answer: null, workable: true,
  });
  expect(Object.keys(r.json).sort()).toEqual(["anchor", "anchorLabel", "anchorRemoved", "answer", "assigneeId", "createdAt", "dependsOn", "id", "kind", "number", "projectId", "question", "specChangedVersion", "status", "stoppedMidway", "title", "todo", "updatedAt", "workable"]); // + stoppedMidway (TASK-119, SPEC-108 D7)
  expect(r.json.stoppedMidway).toBeNull();
  expect((await newCard(call, project.id)).json).toMatchObject({ number: 2, assigneeId: null });
  const stranger = (await call("POST", "/v1/workers", { name: "Zed", role: "BE", skills: ["x"] })).json;
  const nm = await newCard(call, project.id, { assigneeId: stranger.id });
  expect([nm.status, nm.json.error.code]).toEqual([400, "not_a_member"]);
  const w = await newCard(call, project.id, {}).then(() => call("POST", `/v1/projects/${project.id}/cards`, { title: "t", todo: "", anchor: { key: "STEP-004", version: 1 } }, as(a)));
  expect([w.status, w.json.error.code]).toEqual([403, "operator_only"]);
  expect((await newCard(call, "00000000-0000-0000-0000-000000000099")).status).toBe(404);
  // was: Blueprint down → 502 for STEP-004. REQ-105 (D4): a part CAW has read before is served from the last body read (AC-5), so a card on it can still be cut; a part it never read → 502 as before
  fake.mode.down = true;
  expect((await newCard(call, project.id)).status).toBe(201); // STEP-004 was read by the cards above
  const down = await newCard(call, project.id, { anchor: { key: "STEP-005" } });
  expect([down.status, down.json.error.code]).toEqual([502, "blueprint_unreachable"]);
});

test("dependsOn: cards of the same project only; a card with an open dependency is not workable until it is done", async () => {
  const { call } = await setup();
  const { project } = await chainOf3(call);
  const first = (await newCard(call, project.id)).json;
  const second = (await newCard(call, project.id, { dependsOn: [first.id] })).json;
  expect([second.dependsOn, second.workable]).toEqual([[first.id], false]);
  expect((await newCard(call, project.id, { dependsOn: ["00000000-0000-0000-0000-000000000099"] })).status).toBe(400);
  const other = (await call("POST", "/v1/projects", { blueprintProjectId: "x", version: 1 })).status; // no such Blueprint project
  expect(other).toBe(404);
  await call("PATCH", `/v1/cards/${first.id}/status`, { status: "done" });
  expect((await call("GET", `/v1/cards/${second.id}`)).json.workable).toBe(true);
});

test("GET cards: filters assigneeId · status · workable=true; GET card by id; 404", async () => {
  const { call } = await setup();
  const { project, a, b } = await chainOf3(call);
  const c1 = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const c2 = (await newCard(call, project.id, { assigneeId: b.id, dependsOn: [c1.id] })).json;
  const c3 = (await newCard(call, project.id, { assigneeId: a.id })).json;
  await call("PATCH", `/v1/cards/${c3.id}/status`, { status: "review" });
  const ids = async (q: string) => (await call("GET", `/v1/projects/${project.id}/cards${q}`)).json.cards.map((x: any) => x.number);
  expect(await ids("")).toEqual([1, 2, 3]);
  expect(await ids(`?assigneeId=${a.id}`)).toEqual([1, 3]);
  expect(await ids("?status=review")).toEqual([3]);
  expect(await ids("?workable=true")).toEqual([1]); // 2 waits on 1, 3 is in review
  expect(await ids(`?assigneeId=${b.id}&workable=true`)).toEqual([]);
  expect((await call("GET", `/v1/projects/${project.id}/cards?status=nope`)).status).toBe(400);
  expect((await call("GET", `/v1/cards/${c2.id}`)).json).toMatchObject({ id: c2.id, dependsOn: [c1.id] });
  expect((await call("GET", "/v1/cards/00000000-0000-0000-0000-000000000099")).status).toBe(404);
  expect((await call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/cards")).status).toBe(404);
});

// was: "spec = Blueprint's PartContext … (STEP-004 @ v1) … 502 when Blueprint is down". REQ-105: the v2 context of the current spec (+ specRead); Blueprint down → the last body read (fromCache); 502 only when the part is gone/never read.
test("AC-3 context: spec = Blueprint's v2 part context exactly as returned (STEP-004, current spec) + specRead + the card's notes, oldest first; Blueprint down → the last body read; 404 anchor_removed when the part has left the spec", async () => {
  const { call, fake } = await setup();
  const { project, a } = await chainOf3(call);
  const card = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const hop = await openHop(call, project.id, card.id, a.id); // v1.5: a worker writes from its running hop
  await call("POST", `/v1/cards/${card.id}/comments`, { text: "เริ่มแล้ว" });
  await call("POST", `/v1/cards/${card.id}/comments`, { text: "เจอข้อสงสัย" }, as(a), hopHeader(hop.id));
  const ctx = (await call("GET", `/v1/cards/${card.id}/context`)).json;
  const { version: _v, confirmedAt: _c, ...recorded } = fix("context-v1-step-004"); // synthetic v2 = the recorded v1 context with revision / savedAt / latestLabel instead of version / confirmedAt
  expect(ctx.spec).toMatchObject({ ...recorded, revision: 1, latestLabel: { version: 1, label: "v1" } });
  expect(ctx.spec.version).toBeUndefined();
  expect(ctx.spec.confirmedAt).toBeUndefined();
  expect(ctx.specRead).toMatchObject({ revision: 1, fromCache: false, pinned: false }); // the operator has no hop: the latest read
  expect(typeof ctx.specRead.readAt).toBe("string");
  expect(ctx.card).toMatchObject({ id: card.id, number: 1 });
  expect(ctx.notes.map((n: any) => [n.type, n.actor, n.text])).toEqual([["comment", "operator", "เริ่มแล้ว"], ["comment", as(a), "เจอข้อสงสัย"]]);
  expect(Object.keys(ctx.notes[0]).sort()).toEqual(["actor", "allowed", "at", "fromWorkerId", "id", "text", "toWorkerId", "type"]);
  expect(ctx.notes[0].allowed).toBeNull(); // allowed is only for a handoff_refused note (v1.3)
  expect(ctx.decisions).toEqual([]);
  expect(fake.mode.calls.at(-1)).toBe(`GET /v1/projects/${fix("project-200").project.id}/spec/parts/STEP-004/context`);
  fake.mode.down = true;
  const down = await call("GET", `/v1/cards/${card.id}/context`); // was 502
  expect([down.status, down.json.specRead.fromCache, down.json.spec]).toEqual([200, true, ctx.spec]);
  fake.mode.down = false;
  fake.mode.gone.add("STEP-004"); // the part has left the current spec: nothing to give the worker
  const gone = await call("GET", `/v1/cards/${card.id}/context`);
  expect([gone.status, gone.json.error.code]).toEqual([404, "anchor_removed"]); // was 502 blueprint_unreachable — REQ-105 D12 (Q4): a removed part has its own answer
  expect((await call("GET", "/v1/cards/00000000-0000-0000-0000-000000000099/context")).status).toBe(404);
});

test("comments: the operator on any card; a worker only from its running hop (400 / 409, v1.5) on a card still assigned to it (403 not_your_card); text 1–8 000; 404", async () => {
  const { call } = await setup();
  const { project, a, b } = await chainOf3(call);
  const card = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const C = `/v1/cards/${card.id}/comments`;
  const hop = await openHop(call, project.id, card.id, a.id);
  const mine = await call("POST", C, { text: "จากเจ้าของ" }, as(a), hopHeader(hop.id));
  expect(mine.status).toBe(201);
  expect(mine.json).toMatchObject({ type: "comment", actor: as(a), text: "จากเจ้าของ", fromWorkerId: null, toWorkerId: null });
  const noHop = await call("POST", C, { text: "ไม่ใช่งานฉัน" }, as(b)); // Ben has no hop on this card
  expect([noHop.status, noHop.json.error.code]).toEqual([400, "hop_required"]);
  const theirs = await call("POST", C, { text: "ไม่ใช่งานฉัน" }, as(b), hopHeader(hop.id)); // Ben presenting Ann's hop
  expect([theirs.status, theirs.json.error.code]).toEqual([409, "hop_not_running"]);
  expect((await call("POST", C, { text: "operator" })).status).toBe(201);
  expect((await call("POST", C, { text: "" })).status).toBe(400);
  expect((await call("POST", C, { text: "x".repeat(8001) })).status).toBe(400);
  expect((await call("POST", "/v1/cards/00000000-0000-0000-0000-000000000099/comments", { text: "x" })).status).toBe(404);
  // a running hop of Ann's on a card that is NOT assigned to her: the hop check passes, ownership does not
  await call("PATCH", `/v1/hops/${hop.id}`, { outcome: "stopped" });
  const unassigned = (await newCard(call, project.id)).json;
  const hopOnUnassigned = await openHop(call, project.id, unassigned.id, a.id);
  expect((await call("POST", `/v1/cards/${unassigned.id}/comments`, { text: "x" }, as(a), hopHeader(hopOnUnassigned.id))).json.error.code).toBe("not_your_card");
});

test("AC-4 hand-off: along a chain edge → 200 (the card moves to the next worker + a handoff note); off the chain → 409 chain_broken with `allowed`; not your card → 403", async () => {
  const { call } = await setup();
  const { project, a, b, c } = await chainOf3(call);
  await call("POST", `/v1/projects/${project.id}/chain/edges`, { from: a.id, to: b.id });
  const card = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const H = `/v1/cards/${card.id}/handoff`;
  const hopA = await openHop(call, project.id, card.id, a.id);
  const HA = hopHeader(hopA.id);

  const broken = await call("POST", H, { toWorkerId: c.id, text: "ส่งต่อ QA" }, as(a), HA);
  expect([broken.status, broken.json.error.code, broken.json.error.details]).toEqual([409, "chain_broken", { from: a.id, allowed: [b.id], allowedWorkers: [{ id: b.id, name: "Ben", roles: ["FE"] }] }]);
  expect(broken.json.error.message).toEndWith(`— you may hand to: Ben (FE) ${b.id}`); // SPEC-116 D3.3
  const notYours = await call("POST", H, { toWorkerId: c.id, text: "x" }, as(b), HA); // Ben has no hop of his own: v1.5 stops him first
  expect([notYours.status, notYours.json.error.code]).toEqual([409, "hop_not_running"]);
  expect((await call("POST", H, { toWorkerId: b.id, text: "" }, as(a), HA)).status).toBe(400);
  expect((await call("POST", H, { toWorkerId: "00000000-0000-0000-0000-000000000099", text: "x" }, as(a), HA)).status).toBe(409);

  const ok = await call("POST", H, { toWorkerId: b.id, text: "ทำฝั่งหน้าจอต่อ" }, as(a), HA);
  expect(ok.status).toBe(200);
  expect(ok.json).toMatchObject({ id: card.id, assigneeId: b.id });
  const note = (await call("GET", `/v1/cards/${card.id}/context`)).json.notes.at(-1);
  expect(note).toMatchObject({ type: "handoff", actor: as(a), text: "ทำฝั่งหน้าจอต่อ", fromWorkerId: a.id, toWorkerId: b.id });
  // now it is b's: a (whose hop is still running on the card) can no longer hand it off, b has no edge out
  expect((await call("POST", H, { toWorkerId: c.id, text: "x" }, as(a), HA)).json.error.code).toBe("not_your_card");
  await call("PATCH", `/v1/hops/${hopA.id}`, { outcome: "handed_off" });
  const hopB = await openHop(call, project.id, card.id, b.id);
  const none = await call("POST", H, { toWorkerId: a.id, text: "x" }, as(b), hopHeader(hopB.id));
  expect([none.status, none.json.error.details]).toEqual([409, { from: b.id, allowed: [], allowedWorkers: [] }]);
  expect(none.json.error.message).toEndWith("— you may hand to: nobody");
});

// The "a name matching two recipients is refused" half of D3.4 cannot be reached through the API: live worker names are unique (index workers_name_live, v1.14).
test("SPEC-116 D3.4 hand-off by NAME: the name of one recipient (trimmed) → 200 and the stored toWorkerId is its id; an unknown name, or a name that is not a recipient's → 409 listing who is", async () => {
  const { call } = await setup();
  const { project, a, b, c } = await chainOf3(call);
  await call("POST", `/v1/projects/${project.id}/chain/edges`, { from: a.id, to: c.id });
  await call("POST", `/v1/projects/${project.id}/chain/edges`, { from: a.id, to: b.id });
  const card = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const H = `/v1/cards/${card.id}/handoff`;
  const hop = await openHop(call, project.id, card.id, a.id);
  const unknown = await call("POST", H, { toWorkerId: "Zed", text: "x" }, as(a), hopHeader(hop.id));
  expect([unknown.status, unknown.json.error.code]).toEqual([409, "chain_broken"]);
  expect(unknown.json.error.details.allowedWorkers).toEqual([b, c].map((w) => ({ id: w.id, name: w.name, roles: w.roles })).sort((x, y) => (x.id < y.id ? -1 : 1)));
  const notARecipient = await call("POST", H, { toWorkerId: "Ann", text: "x" }, as(a), hopHeader(hop.id)); // a real worker, but not one Ann may hand to
  expect([notARecipient.status, notARecipient.json.error.code]).toEqual([409, "chain_broken"]);
  const ok = await call("POST", H, { toWorkerId: "  Cat ", text: "ทำต่อ" }, as(a), hopHeader(hop.id));
  expect([ok.status, ok.json.assigneeId]).toEqual([200, c.id]);
  const note = (await call("GET", `/v1/cards/${card.id}/context`)).json.notes.at(-1);
  expect([note.type, note.toWorkerId]).toEqual(["handoff", c.id]); // the id, never the name
});

test("SPEC-116 D3.1 card_context.handOffTo: [{ id, name, roles }] for a card whose worker has one edge, [] when it has none", async () => {
  const { call } = await setup();
  const { project, a, b } = await chainOf3(call);
  await call("POST", `/v1/projects/${project.id}/chain/edges`, { from: a.id, to: b.id });
  const mine = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const dead = (await newCard(call, project.id, { assigneeId: b.id })).json; // Ben has no edge out
  const free = (await newCard(call, project.id)).json; // no assignee
  expect((await call("GET", `/v1/cards/${mine.id}/context`)).json.handOffTo).toEqual([{ id: b.id, name: "Ben", roles: ["FE"] }]);
  expect((await call("GET", `/v1/cards/${dead.id}/context`)).json.handOffTo).toEqual([]);
  expect((await call("GET", `/v1/cards/${free.id}/context`)).json.handOffTo).toEqual([]);
});

test("status: the assigned worker from its running hop or the operator; `doing` while a dependency is open → 409 waiting_on_question; bad value → 400", async () => {
  const { call } = await setup();
  const { project, a, b } = await chainOf3(call);
  const first = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const second = (await newCard(call, project.id, { assigneeId: b.id, dependsOn: [first.id] })).json;
  const S = (id: string, status: string, actor = "operator") => call("PATCH", `/v1/cards/${id}/status`, { status }, actor);
  const hopA = await openHop(call, project.id, first.id, a.id);
  const SA = (id: string, status: string) => call("PATCH", `/v1/cards/${id}/status`, { status }, as(a), hopHeader(hopA.id));
  expect((await SA(first.id, "doing")).json.status).toBe("doing");
  expect((await call("PATCH", `/v1/cards/${first.id}/status`, { status: "review" }, as(b), hopHeader(hopA.id))).json.error.code).toBe("hop_not_running"); // Ben, on Ann's hop
  expect((await S(first.id, "blocked")).status).toBe(400);
  const waiting = await S(second.id, "doing"); // the rule holds for every actor; `second` is not workable, so no worker can hold a hop on it yet
  expect([waiting.status, waiting.json.error.code]).toEqual([409, "waiting_on_question"]);
  expect((await S(second.id, "stuck")).json.status).toBe("stuck"); // anything but `doing` is allowed while waiting
  await SA(first.id, "done");
  await call("PATCH", `/v1/hops/${hopA.id}`, { outcome: "status" });
  await S(second.id, "todo"); // out of `stuck`, so that it is workable again for Ben's hop
  const hopB = await openHop(call, project.id, second.id, b.id);
  expect((await call("PATCH", `/v1/cards/${second.id}/status`, { status: "doing" }, as(b), hopHeader(hopB.id))).json.status).toBe("doing");
  expect((await S("00000000-0000-0000-0000-000000000099", "done")).status).toBe(404);
});

test("assignee: the operator moves a card to any member (ignoring the chain); a non-member → 400 not_a_member; a worker → 403 operator_only", async () => {
  const { call } = await setup();
  const { project, a, b } = await chainOf3(call);
  const stranger = (await call("POST", "/v1/workers", { name: "Zed", role: "BE", skills: ["x"] })).json;
  const card = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const A = `/v1/cards/${card.id}/assignee`;
  expect((await call("PATCH", A, { workerId: b.id })).json.assigneeId).toBe(b.id); // no edge a→b needed
  const nm = await call("PATCH", A, { workerId: stranger.id });
  expect([nm.status, nm.json.error.code]).toEqual([400, "not_a_member"]);
  const w = await call("PATCH", A, { workerId: a.id }, as(b));
  expect([w.status, w.json.error.code]).toEqual([403, "operator_only"]);
});

test("AC-7 question card: the asking card stops being workable, an unrelated card stays workable; the operator's answer frees it; decisions show in its context", async () => {
  const { call } = await setup();
  const { project, a, b } = await chainOf3(call);
  const asking = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const unrelated = (await newCard(call, project.id, { assigneeId: b.id, title: "อีกงาน" })).json;
  const Q = `/v1/cards/${asking.id}/question`;
  const body = { text: "ห้องใหญ่ต้องให้ผู้ดูแลอนุมัติไหม", proposedDefault: "ต้องอนุมัติ", cases: ["ห้องเล็ก", "ห้องใหญ่"] };
  const hopA = await openHop(call, project.id, asking.id, a.id);
  const HA = hopHeader(hopA.id);

  expect((await call("POST", Q, { ...body, cases: [] }, as(a), HA)).status).toBe(400);
  expect((await call("POST", Q, { ...body, cases: Array.from({ length: 11 }, (_, i) => `c${i}`) }, as(a), HA)).status).toBe(400);
  expect((await call("POST", Q, body, as(b), HA)).json.error.code).toBe("hop_not_running"); // Ben on Ann's hop
  const q = await call("POST", Q, body, as(a), HA);
  expect(q.status).toBe(201);
  expect(q.json).toMatchObject({
    kind: "question", assigneeId: null, status: "todo", number: 3, anchor: { key: "STEP-004", version: 1 },
    question: { text: body.text, proposedDefault: "ต้องอนุมัติ", cases: ["ห้องเล็ก", "ห้องใหญ่"] }, answer: null, workable: false,
  });
  const after = async (id: string) => (await call("GET", `/v1/cards/${id}`)).json;
  expect(await after(asking.id)).toMatchObject({ workable: false, dependsOn: [q.json.id] });
  expect((await after(unrelated.id)).workable).toBe(true);
  expect((await call("GET", `/v1/projects/${project.id}/cards?workable=true`)).json.cards.map((c: any) => c.number)).toEqual([2]);
  expect((await call("PATCH", `/v1/cards/${asking.id}/status`, { status: "doing" }, as(a), HA)).json.error.code).toBe("waiting_on_question");
  expect((await call("PATCH", `/v1/cards/${q.json.id}/status`, { status: "done" })).status).toBe(400); // a question is answered, not moved
  expect((await call("PATCH", `/v1/cards/${q.json.id}/assignee`, { workerId: a.id })).status).toBe(400);
  expect((await call("POST", `/v1/cards/${q.json.id}/question`, body)).status).toBe(400); // a question card does not ask

  const A = `/v1/cards/${q.json.id}/answer`;
  expect((await call("POST", A, { answer: "ใช่" }, as(a))).json.error.code).toBe("operator_only");
  const notQ = await call("POST", `/v1/cards/${asking.id}/answer`, { answer: "x" });
  expect([notQ.status, notQ.json.error.code]).toEqual([400, "not_a_question"]);
  expect((await call("POST", A, { answer: "" })).status).toBe(400);
  const done = await call("POST", A, { answer: "ใช่ ต้องอนุมัติ" });
  expect(done.status).toBe(200);
  expect(done.json).toMatchObject({ status: "done", answer: "ใช่ ต้องอนุมัติ" });
  const twice = await call("POST", A, { answer: "เปลี่ยนใจ" });
  expect([twice.status, twice.json.error.code]).toEqual([409, "already_answered"]);

  expect((await after(asking.id)).workable).toBe(true);
  const ctx = (await call("GET", `/v1/cards/${asking.id}/context`)).json;
  expect(ctx.decisions).toEqual([{ cardId: q.json.id, number: 3, question: body.text, answer: "ใช่ ต้องอนุมัติ" }]);
});

// was: "…so the card is workable again" (flagged: workable false). REQ-105 D7 (PM's Q2): the flag only SHOWS — a flagged card is still workable; `clear` just dismisses the mark.
test("spec-change/clear: operator only; sets specChangedVersion back to null (the mark goes; the card was workable all along — the flag no longer stops it)", async () => {
  const { call, db } = await setup();
  const { project, a } = await chainOf3(call);
  const card = (await newCard(call, project.id, { assigneeId: a.id })).json;
  await db.execute(sql`update caw.cards set spec_changed_version = 2 where id = ${card.id}`); // what A-073's pull will write
  expect((await call("GET", `/v1/cards/${card.id}`)).json).toMatchObject({ specChangedVersion: 2, workable: true }); // was workable: false
  expect((await call("POST", `/v1/cards/${card.id}/spec-change/clear`, undefined, as(a))).json.error.code).toBe("operator_only");
  const r = await call("POST", `/v1/cards/${card.id}/spec-change/clear`);
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ specChangedVersion: null, workable: true });
  expect((await call("POST", "/v1/cards/00000000-0000-0000-0000-000000000099/spec-change/clear")).status).toBe(404);
});

test("an id that is no uuid is simply not found (404), never a database error (500) — projects, cards, chain, events", async () => {
  const { call } = await setup();
  for (const path of ["/v1/projects/not-a-uuid", "/v1/projects/not-a-uuid/events", "/v1/projects/not-a-uuid/chain", "/v1/projects/not-a-uuid/cards", "/v1/cards/not-a-uuid", "/v1/cards/not-a-uuid/context"]) {
    const r = await call("GET", path);
    expect([path, r.status, r.json.error.code]).toEqual([path, 404, "not_found"]);
  }
  expect((await call("POST", "/v1/projects/not-a-uuid/rebuild-check")).status).toBe(404);
  expect((await call("POST", "/v1/cards/not-a-uuid/comments", { text: "x" })).status).toBe(404);
  expect((await call("PATCH", "/v1/cards/not-a-uuid/status", { status: "done" })).status).toBe(404);
});
