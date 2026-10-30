// AC-6 for TASK-A-072: a scripted sequence touching every event type of this TASK, then rebuild-check says the tables
// are exactly what the events replay to. Also: concurrent writes to one project all land.
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { events } from "../../src/db/schema";
import { mkWorker, newCard, setup } from "../helpers/api";

test("rebuild-check → same:true after a sequence touching every event type of A-071 + A-072", async () => {
  const { call, db } = await setup();
  const project = (await call("POST", "/v1/projects", { blueprintProjectId: (await import("../helpers/fake-blueprint")).BP_PROJECT, version: 1 })).json;
  const P = `/v1/projects/${project.id}`;
  const check = async () => (await call("POST", `${P}/rebuild-check`)).json;
  const a = await mkWorker(call, "Ann", "BE", ["s1"]);
  const b = await mkWorker(call, "Ben", "FE", ["s2"]);
  const c = await mkWorker(call, "Cat", "QA", ["s3"]);
  const ab = (await call("POST", "/v1/workers/combine", { name: "AnnBen", workerIds: [a.id, b.id] })).json;
  expect(await check()).toEqual({ same: true });
  for (const w of [a, b, c, ab]) await call("POST", `${P}/chain/members`, { workerId: w.id });
  await call("POST", `${P}/chain/edges`, { from: a.id, to: b.id });
  await call("POST", `${P}/chain/edges`, { from: b.id, to: c.id });
  await call("DELETE", `${P}/chain/edges`, { from: b.id, to: c.id });
  await call("PUT", `${P}/chain/entry`, { workerId: a.id });
  const k1 = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const k2 = (await newCard(call, project.id, { assigneeId: c.id, dependsOn: [k1.id] })).json;
  // v1.5: a worker writes from a running hop of its own on the card
  const hopA = (await call("POST", `${P}/hops`, { cardId: k1.id, workerId: a.id })).json;
  const HA = { "x-caw-hop": hopA.id };
  await call("PATCH", `/v1/cards/${k1.id}/status`, { status: "doing" }, `worker:${a.id}`, HA);
  await call("POST", `/v1/cards/${k1.id}/comments`, { text: "บันทึก" }, `worker:${a.id}`, HA);
  expect((await call("POST", `/v1/cards/${k1.id}/handoff`, { toWorkerId: c.id, text: "ข้ามสาย" }, `worker:${a.id}`, HA)).status).toBe(409); // a → c has no edge: refused, and recorded (v1.3)
  await call("POST", `/v1/cards/${k1.id}/handoff`, { toWorkerId: b.id, text: "ส่งต่อ", reason: "ต้องมีหน้าจอ" }, `worker:${a.id}`, HA); // BE → FE-only: a reason (REQ-125)
  await call("PATCH", `/v1/hops/${hopA.id}`, { outcome: "handed_off" });
  await call("PATCH", `/v1/cards/${k2.id}/assignee`, { workerId: b.id });
  const hopB = (await call("POST", `${P}/hops`, { cardId: k1.id, workerId: b.id })).json;
  const q = (await call("POST", `/v1/cards/${k1.id}/question`, { text: "ถามหน่อย", proposedDefault: "ค่าเริ่มต้น", cases: ["ก", "ข"] }, `worker:${b.id}`, { "x-caw-hop": hopB.id })).json;
  await call("PATCH", `/v1/hops/${hopB.id}`, { outcome: "asked" });
  expect(await check()).toEqual({ same: true });
  await call("POST", `/v1/cards/${q.id}/answer`, { answer: "ตอบแล้ว" });
  await db.execute(sql`update caw.cards set spec_changed_version = 2 where id = ${k2.id}`); // what A-073's pull will write; the clear below then makes it null in both
  await call("POST", `/v1/cards/${k2.id}/spec-change/clear`);
  await call("DELETE", `${P}/chain/members/${a.id}?reassignTo=${b.id}`).then((r) => expect(r.status).toBe(409)); // a is the entry
  await call("PUT", `${P}/chain/entry`, { workerId: b.id });
  expect((await call("DELETE", `${P}/chain/members/${a.id}?reassignTo=${b.id}`)).status).toBe(200);
  expect(await check()).toEqual({ same: true });

  const types = new Set((await db.select({ type: events.type }).from(events)).map((e) => e.type));
  for (const t of ["project.created", "worker.created", "worker.combined", "chain.member_added", "chain.member_removed", "chain.edge_added", "chain.edge_removed", "chain.entry_set",
    "card.created", "card.status_set", "card.assigned", "card.handed_off", "card.handoff_refused", "card.commented", "card.question_opened", "card.question_answered", "card.spec_change_cleared",
    "hop.started", "hop.finished"]) {
    expect([t, types.has(t)]).toEqual([t, true]);
  }
});

test("concurrent writes to one project all land (one lock per project) and the tables still equal a rebuild", async () => {
  const { call } = await setup();
  const project = (await call("POST", "/v1/projects", { blueprintProjectId: (await import("../helpers/fake-blueprint")).BP_PROJECT, version: 1 })).json;
  const w = await mkWorker(call, "Ann", "BE");
  await call("POST", `/v1/projects/${project.id}/chain/members`, { workerId: w.id });
  const card = (await newCard(call, project.id, { assigneeId: w.id })).json;
  await Promise.all(Array.from({ length: 12 }, (_, i) => call("POST", `/v1/cards/${card.id}/comments`, { text: `n${i}` })));
  const notes = (await call("GET", `/v1/cards/${card.id}/context`)).json.notes;
  expect(notes).toHaveLength(12);
  expect(new Set(notes.map((n: any) => n.text)).size).toBe(12);
  expect((await call("POST", `/v1/projects/${project.id}/rebuild-check`)).json).toEqual({ same: true });
});

// AC-6 for TASK-A-073: mode + budget, workspace, runs, hops (claim, finish, interrupted), statuses and the pull's spec changes —
// after them rebuild-check is same:true AND the rebuilt mode / budget / hopsUsed / statuses are shown equal to the tables.
test("AC-6 with mode, budget, workspace, runs, claims, hops and spec changes: rebuild = tables (values printed)", async () => {
  const { call, db, follow, fake } = await setup();
  const { BP_PROJECT } = await import("../helpers/fake-blueprint");
  const { loadState } = await import("../../src/core/state");
  const { rebuild } = await import("../../src/core/rebuild");
  const project = (await call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT, version: 1 })).json;
  const P = `/v1/projects/${project.id}`;
  const a = await mkWorker(call, "Ann", "BE");
  await call("POST", `${P}/chain/members`, { workerId: a.id });
  const cards = [] as any[];
  for (const key of ["STEP-004", "STEP-002", "STEP-001"]) cards.push((await newCard(call, project.id, { assigneeId: a.id, anchor: { key, version: 1 } })).json);
  await call("PATCH", `${P}/mode`, { mode: "dispatcher", hopBudget: 4 });
  await call("PATCH", `${P}/workspace`, { roots: ["/work/app", "/work/web"] });
  const run = (await call("POST", `${P}/runs`, { hopBudget: 3 })).json;
  const h1 = (await call("POST", `${P}/hops`, { cardId: cards[1].id, workerId: a.id, runId: run.id, claim: "runner-1" })).json;
  await call("PATCH", `/v1/cards/${cards[1].id}/status`, { status: "doing" });
  await call("PATCH", `/v1/hops/${h1.id}`, { outcome: "commented", tokensIn: 10, tokensOut: 5, note: "ok" });
  const h2 = (await call("POST", `${P}/hops`, { cardId: cards[1].id, workerId: a.id, runId: run.id })).json;
  await call("PATCH", `/v1/hops/${h2.id}`, { claim: "runner-2" });
  await call("PATCH", `/v1/hops/${h2.id}`, { outcome: "interrupted" });
  await call("PATCH", `/v1/cards/${cards[1].id}/status`, { status: "review" });
  // REQ-105: the pull follows REVISIONS (was: the recorded v2/v3 feed). Synthetic change sets 2 (STEP-004) and 3 (STEP-001) → one spec.revised flags cards[0] and cards[2] with revision 3
  for (const [rev, key] of [[2, "STEP-004"], [3, "STEP-001"]] as const) fake.mode.changes.push({ rev, at: "2026-10-29T07:00:00.000Z", by: "โด่ง", cause: "edit", added: [], changed: [key], removed: [] });
  fake.mode.spec.revision = 3;
  await follow.pullAll();
  await call("POST", `/v1/cards/${cards[0].id}/spec-change/clear`);
  await call("PATCH", `/v1/runs/${run.id}`, { stopReason: "operator_stopped", report: "หยุดเอง" });
  void fake;

  expect(await (await call("POST", `${P}/rebuild-check`)).json).toEqual({ same: true });
  const tables = await loadState(db, project.id), rebuilt = await rebuild(db, project.id);
  const view = (s: typeof tables) => ({
    mode: s.project!.mode, hopBudget: s.project!.hopBudget, hopsUsed: s.project!.hopsUsed, workspace: s.project!.workspace.roots, latestSeenVersion: s.project!.latestSeenVersion,
    statuses: s.cards.map((c) => `${c.number}:${c.status}:${c.specChangedVersion ?? "-"}`), hops: s.hops.map((h) => `${h.outcome}:${h.claimedBy ?? "-"}:${h.runId ? "run" : "-"}`),
    runs: s.runs.map((r) => `${r.stopReason}:${r.hopBudget}`),
  });
  console.log("AC-6 tables :", JSON.stringify(view(tables)));
  console.log("AC-6 rebuilt:", JSON.stringify(view(rebuilt)));
  expect(view(rebuilt)).toEqual(view(tables));
  expect(view(tables)).toEqual({
    mode: "dispatcher", hopBudget: 4, hopsUsed: 2, workspace: ["/work/app", "/work/web"], latestSeenVersion: 1, // the label number (D2) — the fake's label is v1; it did not change
    statuses: ["1:todo:-", "2:review:-", "3:todo:3"], hops: ["commented:runner-1:run", "interrupted:runner-2:run"], runs: ["operator_stopped:3"],
  });
  const types = new Set((await db.select({ type: events.type }).from(events)).map((e) => e.type));
  for (const t of ["project.mode_set", "project.workspace_set", "run.started", "run.finished", "hop.started", "hop.claimed", "hop.finished", "spec.revised"]) expect([t, types.has(t)]).toEqual([t, true]);
});
