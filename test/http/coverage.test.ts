// REQ-112 (SPEC-109 D2/D4, TASK-121): GET /v1/projects/{projectId}/coverage — the decisions of Blueprint's CURRENT spec that no work card (nor the asked-for proposal) covers.
// TEST-106's shape: DEC-001…003 cover STEP-002, DEC-005 covers SCR-001, and one card is anchored on SCR-001. The fake Blueprint's `/spec` parts/links and the `relatedDecisions` a
// context carries are SYNTHETIC (SPEC-106 v2 + REQ-112 addition, until recorded): a test sets `fake.mode.snapshot`, `.decisionsOn`, `.related`.
import { expect, test } from "bun:test";
import { writeEvent } from "../../src/core/write";
import { chatWorld, newCard, postChat, setup } from "../helpers/api";
import { BP_PROJECT } from "../helpers/fake-blueprint";

const part = (key: string, kind: string, title: string) => ({ key, kind, title, body: {}, origin: { date: "2026-10-30", stamp: "operator" } });
const link = (fromKey: string, toKey: string, kind = "covers") => ({ id: `${fromKey}>${toKey}`, kind, fromKey, toKey, position: null, label: null });
const DEC = (n: number) => part(`DEC-00${n}`, "decision", `กฎข้อ ${n}`);
const STEP2 = part("STEP-002", "step", "เช็คสถานะ");
const SCR1 = part("SCR-001", "screen", "หน้าจองห้อง");

async function world() {
  const s = await setup();
  const chain = await chatWorld(s.call);
  const P = `/v1/projects/${chain.project.id}`;
  s.fake.mode.snapshot = {
    parts: [STEP2, SCR1, DEC(1), DEC(2), DEC(3), DEC(5)],
    links: [link("DEC-001", "STEP-002"), link("DEC-002", "STEP-002"), link("DEC-003", "STEP-002"), link("DEC-005", "SCR-001"), link("STEP-002", "SCR-001", "next")],
  };
  s.fake.mode.decisionsOn["SCR-001"] = [DEC(5)]; // the context of SCR-001 lists DEC-005 only (what Blueprint did before TASK-117)
  const card = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id, anchor: { key: "SCR-001" } })).json;
  const cov = (query = "") => s.call("GET", `${P}/coverage${query}`);
  const specReads = () => s.fake.mode.calls.filter((c) => c === `GET /v1/projects/${BP_PROJECT}/spec`).length;
  /** an open proposal whose only item is anchored on `key` (written as the event: the HTTP route wants a located key) */
  const proposeOn = async (projectId: string, messageId: string, key: string) => {
    const id = crypto.randomUUID();
    await writeEvent(s.db, { type: "proposal.made", projectId, actor: `worker:${chain.a.id}`, at: new Date().toISOString(), data: {
      id, messageId, version: 0, supersedes: [], items: [{ title: "ทำ", todo: "ทำ", anchor: { key, version: 0 }, workerId: chain.b.id, dependsOn: [], hops: 1 }],
    } });
    return id;
  };
  const msg = (await postChat(s.call, chain.project.id)).json;
  return { ...s, ...chain, P, card, cov, specReads, proposeOn, msg };
}

test("(a) the card's context has NO relatedDecisions → STEP-002 is listed with DEC-001…003 (the TEST-106 gap)", async () => {
  const w = await world();
  const r = await w.cov();
  expect([r.status, r.json]).toEqual([200, { revision: 1, uncovered: [{ key: "STEP-002", kind: "step", title: "เช็คสถานะ", decisions: ["DEC-001", "DEC-002", "DEC-003"] }] }]);
});

test("(b) the card's context carries relatedDecisions DEC-001…003 → nothing uncovered", async () => {
  const w = await world();
  w.fake.mode.related["SCR-001"] = [1, 2, 3].map((n) => ({ via: "STEP-002", decision: DEC(n) }));
  w.fake.mode.spec.revision = 2; // Blueprint's answer changed, so its revision moved — the memo is per revision
  const r = await w.cov();
  expect([r.status, r.json]).toEqual([200, { revision: 2, uncovered: [] }]);
});

test("(c) a proposal whose item anchors on STEP-002 covers it before any card does; without proposalId it is still listed", async () => {
  const w = await world();
  w.fake.mode.decisionsOn["STEP-002"] = [1, 2, 3].map(DEC); // Blueprint's context of STEP-002 lists the decisions that cover it
  const p = await w.proposeOn(w.project.id, w.msg.id, "STEP-002");
  const without = (await w.cov()).json;
  expect(without.uncovered.map((u: any) => u.key)).toEqual(["STEP-002"]);
  const withIt = await w.cov(`?proposalId=${p}`);
  expect([withIt.status, withIt.json]).toEqual([200, { revision: 1, uncovered: [] }]); // the proposal's anchor counts like a card's, before any card exists
});

test("(d) a decision that covers nothing is listed under itself; rules are grouped per part and sorted by key", async () => {
  const w = await world();
  w.fake.mode.snapshot!.parts.push(DEC(9), part("API-001", "api", "ค้นหาห้อง"));
  w.fake.mode.snapshot!.links.push(link("DEC-004", "API-001"));
  w.fake.mode.snapshot!.parts.push(DEC(4));
  w.fake.mode.spec.revision = 3;
  const r = (await w.cov()).json;
  expect(r.uncovered).toEqual([
    { key: "API-001", kind: "api", title: "ค้นหาห้อง", decisions: ["DEC-004"] },
    { key: "DEC-009", kind: "decision", title: "กฎข้อ 9", decisions: ["DEC-009"] }, // covers nothing: grouped under itself
    { key: "STEP-002", kind: "step", title: "เช็คสถานะ", decisions: ["DEC-001", "DEC-002", "DEC-003"] },
  ]);
});

test("(e) 404 not_found for an unknown project, an unknown proposal, and ANOTHER project's proposal", async () => {
  const w = await world();
  const noProject = await w.call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/coverage");
  expect([noProject.status, noProject.json.error.code, noProject.json.error.message]).toEqual([404, "not_found", "project not found"]);
  const noProposal = await w.cov("?proposalId=00000000-0000-4000-8000-000000000099");
  expect([noProposal.status, noProposal.json.error.code, noProposal.json.error.message]).toEqual([404, "not_found", "proposal not found"]);
  // a second CAW project (a legacy duplicate, made by the event) with a proposal of its own
  const otherId = crypto.randomUUID();
  await writeEvent(w.db, { type: "project.created", projectId: otherId, actor: "operator", at: new Date().toISOString(), data: { id: otherId, name: "other", blueprintProjectId: BP_PROJECT, version: 2 } });
  const otherMsg = crypto.randomUUID();
  await writeEvent(w.db, { type: "chat.posted", projectId: otherId, actor: "operator", at: new Date().toISOString(), data: { id: otherMsg, text: "x" } });
  const foreign = await w.proposeOn(otherId, otherMsg, "STEP-002");
  const r = await w.cov(`?proposalId=${foreign}`);
  expect([r.status, r.json.error.message]).toEqual([404, "proposal not found"]);
  expect((await w.call("GET", `/v1/projects/${otherId}/coverage?proposalId=${foreign}`)).status).toBe(200); // …but it is found on its own project
});

test("(e) a bad proposalId → 400 validation; Blueprint down (nothing in the memo) → 502 blueprint_unreachable; and nothing was written", async () => {
  const w = await world();
  const eventsBefore = (await w.call("GET", `${w.P}/events`)).json.events.length;
  const bad = await w.cov("?proposalId=not-a-uuid");
  expect([bad.status, bad.json.error.code]).toEqual([400, "validation"]);
  w.fake.mode.down = true;
  const down = await w.cov();
  expect([down.status, down.json.error.code]).toEqual([502, "blueprint_unreachable"]);
  w.fake.mode.down = false;
  expect((await w.call("GET", `${w.P}/events`)).json.events.length).toBe(eventsBefore); // a read: no event
});

test("(f) two calls at the same revision and anchors: the answer is the same, `/spec` is read once per call (its revision is the memo's key) and each part's context only ONCE — a new revision, or a new card, recomputes", async () => {
  const w = await world();
  const ctxReads = () => w.fake.mode.calls.filter((c) => c.includes("/spec/parts/")).length;
  const specBefore = w.specReads(), ctxBefore = ctxReads();
  const first = (await w.cov()).json;
  const afterFirst = ctxReads();
  expect(afterFirst - ctxBefore).toBe(1); // one anchor (SCR-001), one context read
  const second = (await w.cov()).json;
  expect(second).toEqual(first);
  expect(ctxReads()).toBe(afterFirst); // memo hit: no part is read again
  expect(w.specReads() - specBefore).toBe(2); // …but the revision is learnt from `/spec` on every call
  w.fake.mode.spec.revision = 2;
  await w.cov();
  expect(ctxReads()).toBeGreaterThan(afterFirst); // the revision moved
  const afterRev = ctxReads();
  await newCard(w.call, w.project.id, { assigneeId: w.a.id, anchor: { key: "STEP-001" } }); // a new anchor
  await w.cov();
  expect(ctxReads()).toBeGreaterThan(afterRev);
});

test("only WORK cards count, whatever their status; an anchor whose part is gone covers nothing and does not fail the read", async () => {
  const w = await world();
  // a done work card on STEP-001 whose context lists DEC-001 covers it
  w.fake.mode.decisionsOn["STEP-001"] = [DEC(1)];
  const done = (await newCard(w.call, w.project.id, { assigneeId: w.a.id, anchor: { key: "STEP-001" } })).json;
  await w.call("PATCH", `/v1/cards/${done.id}/status`, { status: "done" });
  w.fake.mode.spec.revision = 2;
  expect((await w.cov()).json.uncovered).toEqual([{ key: "STEP-002", kind: "step", title: "เช็คสถานะ", decisions: ["DEC-002", "DEC-003"] }]);
  // the SCR-001 part leaves the spec: its context is 404 — it adds nothing (DEC-005 is no longer covered by it)
  w.fake.mode.gone.add("SCR-001");
  w.fake.mode.spec.revision = 3;
  const r = (await w.cov()).json;
  expect(r.uncovered.map((u: any) => u.key)).toEqual(["SCR-001", "STEP-002"]);
});

// REQ-118 (SPEC-117 D3, TASK-149): requirements no card or proposal item takes up are listed under themselves. TEST-106's shape: 8 requirements, every card on REQ-001.
// The fake's requirement parts (`snapshot.parts`, `extraParts`) are SYNTHETIC (SPEC-106 v2 routes 1–2, until recorded).
const REQ = (n: number) => part(`REQ-00${n}`, "requirement", `ข้อกำหนด ${n}`);
async function reqWorld() {
  const w = await world();
  w.fake.mode.snapshot!.parts.push(...[1, 2, 3, 4, 5, 6, 7, 8].map(REQ));
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) w.fake.mode.extraParts[`REQ-00${n}`] = { kind: "requirement", title: `ข้อกำหนด ${n}`, body: { text: `ข้อ ${n}` } };
  const reqsUncovered = async (query = "") => ((await w.cov(query)).json.uncovered as { key: string; kind: string; title: string; decisions: string[] }[]).filter((u) => u.kind === "requirement");
  return { ...w, reqsUncovered };
}

test("(g) 8 requirements, every card on REQ-001 → REQ-002…REQ-008 are listed under themselves, sorted; REQ-001 is not", async () => {
  const w = await reqWorld();
  await newCard(w.call, w.project.id, { assigneeId: w.a.id, anchor: { key: "REQ-001" } });
  const r = await w.reqsUncovered();
  expect(r).toEqual([2, 3, 4, 5, 6, 7, 8].map((n) => ({ key: `REQ-00${n}`, kind: "requirement", title: `ข้อกำหนด ${n}`, decisions: [`REQ-00${n}`] })));
});

test("(g) a proposal item on REQ-004 takes it up (with proposalId); without it REQ-004 is still listed", async () => {
  const w = await reqWorld();
  await newCard(w.call, w.project.id, { assigneeId: w.a.id, anchor: { key: "REQ-001" } });
  const p = await w.proposeOn(w.project.id, w.msg.id, "REQ-004");
  expect((await w.reqsUncovered()).map((u) => u.key)).toContain("REQ-004");
  expect((await w.reqsUncovered(`?proposalId=${p}`)).map((u) => u.key)).toEqual(["REQ-002", "REQ-003", "REQ-005", "REQ-006", "REQ-007", "REQ-008"]);
});

test("(g) a card on a work part takes up no requirement: with only the SCR-001 card, all 8 are listed; a removed requirement is not", async () => {
  const w = await reqWorld();
  expect((await w.reqsUncovered()).map((u) => u.key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `REQ-00${n}`));
  w.fake.mode.snapshot!.parts = w.fake.mode.snapshot!.parts.filter((p) => (p as { key: string }).key !== "REQ-008"); // REQ-008 leaves the spec
  w.fake.mode.spec.revision = 2;
  expect((await w.reqsUncovered()).map((u) => u.key)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `REQ-00${n}`));
});
