// REQ-105 (TASK-114, SPEC-107): caw-back reads Blueprint's CURRENT spec (seam contract v2) — start without a label, the part CAW reads is the latest text, a hop keeps the text it started with (pin),
// Blueprint down is served from the last body read, a failed pin never fails the hop, a flagged card still works. The fake Blueprint's v2 answers are SYNTHETIC (SPEC-106 v2, until recorded):
// the RECORDED v1 context of a chosen version stands in for "the part's text now" (the recorded v1/v2 differ in STEP-004's title, so moving `spec.version` 1 → 2 is "someone edited the part").
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { BlueprintUnreachable, createBlueprint } from "../../src/blueprint/client";
import { cards, followState, hopSpec, projects, specParts } from "../../src/db/schema";
import { chainOf3, createProject, hopHeader, newCard, openHop, setup } from "../helpers/api";
import { BP_PROJECT } from "../helpers/fake-blueprint";

const fix = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/blueprint/${name}.json`, import.meta.url), "utf8"));
const TITLE_V1: string = fix("context-v1-step-004").part.title;
const TITLE_V2: string = fix("context-v2-step-004").part.title;
const as = (w: { id: string }) => `worker:${w.id}`;

test("the recorded v1 and v2 text of STEP-004 differ (the whole pin test below rests on this)", () => {
  expect(TITLE_V1).not.toBe(TITLE_V2);
});

test("D11 start without a label: the project starts from the current spec (label null → version 0), the follow state remembers the revision, cards are cut at label 0, rebuild-check is clean", async () => {
  const { call, fake, db } = await setup();
  fake.mode.spec.label = null; fake.mode.spec.revision = 4;
  const p = await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT }); // no version at all
  expect([p.status, p.json.version, p.json.latestSeenVersion, p.json.latestLabel]).toEqual([201, 0, 0, null]);
  expect(fake.mode.calls).toEqual([`GET /v1/projects/${BP_PROJECT}`, `GET /v1/projects/${BP_PROJECT}/spec`]);
  const [fs] = await db.select().from(followState).where(eq(followState.projectId, p.json.id));
  expect([fs!.lastPulledVersion, fs!.lastPulledRevision, fs!.lastPullOk, fs!.lastPullAt]).toEqual([0, 4, true, null]);

  const [a] = [(await call("POST", "/v1/workers", { name: "Ann", role: "BE", skills: ["x"] })).json];
  await call("POST", `/v1/projects/${p.json.id}/chain/members`, { workerId: a.id });
  const card = await newCard(call, p.json.id, { assigneeId: a.id });
  expect([card.status, card.json.anchor, card.json.anchorLabel, card.json.workable]).toEqual([201, { key: "STEP-004", version: 0 }, null, true]);
  const [row] = await db.select().from(cards).where(eq(cards.id, card.json.id));
  expect([row!.anchorVersion, row!.anchorLabel, row!.anchorRevision]).toEqual([0, null, 4]);
  expect((await call("POST", `/v1/projects/${p.json.id}/rebuild-check`)).json).toEqual({ same: true });

  // and when Blueprint later has a label, a new card is cut at it (its number and words), the old one keeps 0
  fake.mode.spec.label = { version: 2, label: "ส่งมอบรอบแรก" }; fake.mode.spec.revision = 6;
  const later = await newCard(call, p.json.id, {});
  expect([later.json.anchor.version, later.json.anchorLabel]).toEqual([2, "ส่งมอบรอบแรก"]);
  const [laterRow] = await db.select().from(cards).where(eq(cards.id, later.json.id));
  expect(laterRow!.anchorRevision).toBe(6);
  expect((await call("GET", `/v1/cards/${card.json.id}`)).json.anchor.version).toBe(0);
  expect((await call("POST", `/v1/projects/${p.json.id}/rebuild-check`)).json).toEqual({ same: true });
});

test("start: a project Blueprint does not have → 404 blueprint_project_not_found; Blueprint down → 502; nothing written for either", async () => {
  const { call, fake, db } = await setup();
  const nf = await call("POST", "/v1/projects", { blueprintProjectId: "00000000-0000-0000-0000-000000000099" });
  expect([nf.status, nf.json.error.code]).toEqual([404, "blueprint_project_not_found"]);
  fake.mode.down = true;
  const down = await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT });
  expect([down.status, down.json.error.code]).toEqual([502, "blueprint_unreachable"]);
  expect(await db.select().from(projects)).toEqual([]);
  expect(await db.select().from(followState)).toEqual([]);
});

test("a card read is the LATEST text: when the part is edited in Blueprint, the next card_context (operator) has the new text and the new revision", async () => {
  const { call, fake } = await setup();
  const { project, a } = await chainOf3(call);
  const card = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const first = (await call("GET", `/v1/cards/${card.id}/context`)).json;
  expect([first.spec.part.title, first.specRead.revision, first.specRead.fromCache, first.specRead.pinned]).toEqual([TITLE_V1, 1, false, false]);
  fake.mode.spec.version = 2; fake.mode.spec.revision = 2;
  const second = (await call("GET", `/v1/cards/${card.id}/context`)).json;
  expect([second.spec.part.title, second.specRead.revision, second.spec.revision]).toEqual([TITLE_V2, 2, 2]);
  // the card itself was cut at revision 1 and is not edited by the edit
  expect((await call("GET", `/v1/cards/${card.id}`)).json.anchor).toEqual({ key: "STEP-004", version: 1 });
});

test("D5 pin: a card hop keeps the text it started with — the worker's own hop gets the OLD text after the part is edited, the operator and a second look get the NEW one", async () => {
  const { call, fake, db } = await setup();
  const { project, a } = await chainOf3(call);
  const card = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const hop = await openHop(call, project.id, card.id, a.id); // the route reads the part and pins it
  const [pin] = await db.select().from(hopSpec).where(eq(hopSpec.hopId, hop.id));
  expect([pin!.revision, pin!.fromCache, (pin!.body as any).part.title]).toEqual([1, false, TITLE_V1]);

  fake.mode.spec.version = 2; fake.mode.spec.revision = 2; // the part is edited while the worker is working

  const mine = (await call("GET", `/v1/cards/${card.id}/context`, undefined, as(a), hopHeader(hop.id))).json;
  expect([mine.spec.part.title, mine.specRead.pinned, mine.specRead.revision]).toEqual([TITLE_V1, true, 1]);
  const again = (await call("GET", `/v1/cards/${card.id}/context`, undefined, as(a), hopHeader(hop.id))).json;
  expect(again.spec).toEqual(mine.spec); // the same text every time the hop asks

  const operator = (await call("GET", `/v1/cards/${card.id}/context`)).json;
  expect([operator.spec.part.title, operator.specRead.pinned, operator.specRead.revision]).toEqual([TITLE_V2, false, 2]);
  const noHop = (await call("GET", `/v1/cards/${card.id}/context`, undefined, as(a))).json; // a worker without its hop header: the latest
  expect([noHop.spec.part.title, noHop.specRead.pinned]).toEqual([TITLE_V2, false]);

  // the hop ends: the same hop id still gets the text it started with
  const done = await call("PATCH", `/v1/hops/${hop.id}`, { outcome: "commented" }, as(a), hopHeader(hop.id));
  expect(done.status).toBe(200);
  const after = (await call("GET", `/v1/cards/${card.id}/context`, undefined, as(a), hopHeader(hop.id))).json;
  expect([after.spec.part.title, after.specRead.pinned]).toEqual([TITLE_V1, true]);

  // another card's hop is not pinned to THIS card's text: the pin is the worker's own hop on that card only
  const other = (await newCard(call, project.id, { assigneeId: a.id, anchor: { key: "STEP-001" } })).json;
  const otherHop = await openHop(call, project.id, other.id, a.id);
  const cross = await call("GET", `/v1/cards/${card.id}/context`, undefined, as(a), hopHeader(otherHop.id));
  expect(cross.status === 200 ? [cross.json.specRead.pinned, cross.json.spec.part.title] : [cross.status]).toEqual([false, TITLE_V2]);
  expect((await call("POST", `/v1/projects/${project.id}/rebuild-check`)).json).toEqual({ same: true }); // the pin is operational, not an event
});

test("AC-5 Blueprint down: the card context is the last body read with fromCache true; with nothing read for that part → 502; a part removed from the spec drops out of the cache", async () => {
  const { call, fake, db } = await setup();
  const { project, a } = await chainOf3(call);
  const card = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const live = (await call("GET", `/v1/cards/${card.id}/context`)).json;
  fake.mode.down = true;
  const cached = await call("GET", `/v1/cards/${card.id}/context`);
  expect([cached.status, cached.json.specRead.fromCache, cached.json.spec]).toEqual([200, true, live.spec]);
  expect(cached.json.specRead.revision).toBe(live.specRead.revision);

  // nothing read for this part: a card on it can exist (created while up), but the cache is empty → 502 during the outage
  fake.mode.down = false;
  const second = (await newCard(call, project.id, { assigneeId: a.id, anchor: { key: "STEP-005" } })).json;
  await db.delete(specParts).where(eq(specParts.key, "STEP-005"));
  fake.mode.down = true;
  const none = await call("GET", `/v1/cards/${second.id}/context`);
  expect([none.status, none.json.error.code]).toEqual([502, "blueprint_unreachable"]);

  // a 404 for a part CAW has cached: the row is deleted, so a later outage cannot revive it
  fake.mode.down = false;
  fake.mode.gone.add("STEP-004");
  expect((await call("GET", `/v1/cards/${card.id}/context`)).json.error.code).toBe("anchor_removed"); // the card's part has left the spec (was 502 until REQ-105 Q4)
  expect((await db.select().from(specParts).where(eq(specParts.key, "STEP-004")))).toEqual([]);
  fake.mode.down = true;
  // still 502, not anchor_removed: Blueprint cannot be asked and no pull has seen the removal, so CAW does not KNOW the part is gone (D12 answers anchor_removed only when it does)
  expect((await call("GET", `/v1/cards/${card.id}/context`)).status).toBe(502);
});

test("a failed pin never fails the hop: part gone, or Blueprint down with nothing cached → the hop still starts (201), no hop_spec row; card_context falls back to the latest read", async () => {
  const { call, fake, db } = await setup();
  const { project, a } = await chainOf3(call);
  const one = (await newCard(call, project.id, { assigneeId: a.id })).json;
  fake.mode.gone.add("STEP-004"); // the part has left the spec
  const hop = await call("POST", `/v1/projects/${project.id}/hops`, { cardId: one.id, workerId: a.id });
  expect([hop.status, hop.json.cardId, hop.json.endedAt]).toEqual([201, one.id, null]);
  expect(await db.select().from(hopSpec)).toEqual([]);
  fake.mode.gone.delete("STEP-004");
  const ctx = (await call("GET", `/v1/cards/${one.id}/context`, undefined, as(a), hopHeader(hop.json.id))).json;
  expect([ctx.specRead.pinned, ctx.spec.part.title]).toEqual([false, TITLE_V1]); // no pin → the latest read

  // Blueprint down and nothing cached for that part
  const two = (await newCard(call, project.id, { assigneeId: a.id, anchor: { key: "STEP-005" } })).json;
  await call("PATCH", `/v1/hops/${hop.json.id}`, { outcome: "commented" }, as(a), hopHeader(hop.json.id));
  await db.delete(specParts).where(eq(specParts.key, "STEP-005"));
  fake.mode.down = true;
  const hop2 = await call("POST", `/v1/projects/${project.id}/hops`, { cardId: two.id, workerId: a.id });
  expect([hop2.status, hop2.json.cardId]).toEqual([201, two.id]);
  expect(await db.select().from(hopSpec)).toEqual([]);
});

test("D7: a card whose part changed (specChangedVersion set) is workable, a hop starts on it, and the 409 text no longer says \"or its spec changed\"; `clear` still dismisses the mark", async () => {
  const { call, db } = await setup();
  const { project, a } = await chainOf3(call);
  const card = (await newCard(call, project.id, { assigneeId: a.id })).json;
  await db.update(cards).set({ specChangedVersion: 2 }).where(eq(cards.id, card.id));
  expect((await call("GET", `/v1/cards/${card.id}`)).json).toMatchObject({ specChangedVersion: 2, workable: true });
  expect((await call("GET", `/v1/projects/${project.id}/cards?workable=true`)).json.cards.map((c: any) => c.id)).toEqual([card.id]);
  const hop = await call("POST", `/v1/projects/${project.id}/hops`, { cardId: card.id, workerId: a.id });
  expect(hop.status).toBe(201);
  // a card that really is not workable: the 409 names the real reasons only
  const second = (await newCard(call, project.id, { assigneeId: a.id })).json;
  await call("PATCH", `/v1/cards/${second.id}/status`, { status: "done" });
  const refused = await call("POST", `/v1/projects/${project.id}/hops`, { cardId: second.id, workerId: a.id });
  expect([refused.status, refused.json.error.code]).toEqual([409, "not_workable"]);
  expect(refused.json.error.message).not.toContain("spec changed");
  expect((await call("POST", `/v1/cards/${card.id}/spec-change/clear`)).json.specChangedVersion).toBeNull();
  // a flagged card is not counted as stuck any more
  await db.update(cards).set({ specChangedVersion: 3 }).where(eq(cards.id, second.id));
  const summary = (await call("GET", "/v1/projects")).json.projects.find((x: any) => x.id === project.id);
  expect(summary.stuckCount).toBe(0);
});

test("rebuild-check stays clean after cards cut at labels (proposal accept, direct cards) and a project started at label 0 — DoD 9", async () => {
  const { call, fake } = await setup();
  const { project, a } = await chainOf3(call);
  await newCard(call, project.id, { assigneeId: a.id });
  fake.mode.spec.label = { version: 3, label: "ฉบับที่ 3" }; fake.mode.spec.revision = 9;
  const c2 = (await newCard(call, project.id, { assigneeId: a.id, anchor: { key: "STEP-003" } })).json;
  expect([c2.anchor.version, c2.anchorLabel]).toEqual([3, "ฉบับที่ 3"]);
  expect((await call("POST", `/v1/projects/${project.id}/rebuild-check`)).json).toEqual({ same: true });
  expect((await call("GET", `/v1/projects/${project.id}`)).json.latestLabel).toEqual({ version: 1, label: "v1" }); // the project's own label is as it was at the start
});

test("the client's v2 functions: spec / specContext → null on 404; specLocate / specChanges refuse with BlueprintUnreachable; a down Blueprint is unreachable, never a null", async () => {
  const { fake } = await setup();
  const bp = createBlueprint(fake.url);
  const snap = await bp.spec(BP_PROJECT);
  expect(snap).toMatchObject({ revision: 1, latestLabel: { version: 1, label: "v1" } });
  expect(await bp.spec("00000000-0000-0000-0000-000000000099")).toBeNull();
  expect(((await bp.specContext(BP_PROJECT, "STEP-004")) as any).part.title).toBe(TITLE_V1);
  expect(await bp.specContext(BP_PROJECT, "NOPE-999")).toBeNull();
  expect(((await bp.specLocate(BP_PROJECT, "ห้องใหญ่ต้องอนุมัติ")) as any).candidates.length).toBeGreaterThan(0);
  fake.mode.changes = [{ rev: 2, at: "2026-10-29T10:00:00.000Z", by: "โด่ง", cause: "edit", added: [], changed: ["STEP-004"], removed: [] }];
  fake.mode.spec.revision = 2;
  expect(((await bp.specChanges(BP_PROJECT, 1)) as any).changes).toHaveLength(1);
  expect(((await bp.specChanges(BP_PROJECT, 2)) as any).changes).toHaveLength(0);
  await expect(bp.specChanges("00000000-0000-0000-0000-000000000099", 0)).rejects.toBeInstanceOf(BlueprintUnreachable);
  await expect(bp.specLocate("00000000-0000-0000-0000-000000000099", "x")).rejects.toBeInstanceOf(BlueprintUnreachable);
  fake.mode.down = true;
  for (const call of [() => bp.spec(BP_PROJECT), () => bp.specContext(BP_PROJECT, "STEP-004"), () => bp.specLocate(BP_PROJECT, "x"), () => bp.specChanges(BP_PROJECT, 0)]) {
    await expect(call()).rejects.toBeInstanceOf(BlueprintUnreachable);
  }
});

test("`version` in the start body is still accepted when an old caller sends it: version 1 → 201 at the label Blueprint shows", async () => {
  const { call } = await setup();
  const r = await createProject(call, { version: 1 });
  expect([r.status, r.json.version, r.json.latestLabel]).toEqual([201, 1, { version: 1, label: "v1" }]);
});
