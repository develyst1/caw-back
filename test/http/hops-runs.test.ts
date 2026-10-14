// TASK-A-073: hops (REQ-012 R7) and — contract v1.1 — runs, claims, `interrupted`, the run budget.
import { expect, test } from "bun:test";
import { chainOf3, newCard, setup, type Call } from "../helpers/api";

const hopOn = (call: Call, projectId: string, cardId: string, workerId: string, extra: object = {}) =>
  call("POST", `/v1/projects/${projectId}/hops`, { cardId, workerId, ...extra });
const finish = (call: Call, hopId: string, outcome = "commented", extra: object = {}) => call("PATCH", `/v1/hops/${hopId}`, { outcome, ...extra });

async function twoCards() {
  const s = await setup();
  const chain = await chainOf3(s.call);
  const c1 = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id })).json;
  const c2 = (await newCard(s.call, chain.project.id, { assigneeId: chain.b.id })).json;
  return { ...s, ...chain, c1, c2, P: `/v1/projects/${chain.project.id}` };
}

test("a hop: 201 Hop (running) · a second one while it runs → 409 hop_running · finishing it records outcome, tokens, note and counts in hopsUsed", async () => {
  const { call, project, a, b, c1, c2, P } = await twoCards();
  const h = await hopOn(call, project.id, c1.id, a.id);
  expect(h.status).toBe(201);
  expect(h.json).toEqual({ id: h.json.id, projectId: project.id, runId: null, claimedBy: null, cardId: c1.id, messageId: null, locatedKeys: null, workerId: a.id, startedAt: h.json.startedAt, lastActivityAt: h.json.startedAt, endedAt: null, outcome: null, tokensIn: null, tokensOut: null, note: "" });
  const running = await hopOn(call, project.id, c2.id, b.id);
  expect([running.status, running.json.error.code]).toEqual([409, "hop_running"]);
  expect((await call("GET", P)).json.hopsUsed).toBe(0); // counted when it finishes

  const done = await finish(call, h.json.id, "handed_off", { tokensIn: 1200, tokensOut: 340, note: "ส่งต่อให้ Ben" });
  expect(done.status).toBe(200);
  expect(done.json).toMatchObject({ id: h.json.id, outcome: "handed_off", tokensIn: 1200, tokensOut: 340, note: "ส่งต่อให้ Ben" });
  expect(done.json.endedAt).toBeString();
  expect((await call("GET", P)).json.hopsUsed).toBe(1);
  const again = await finish(call, h.json.id);
  expect([again.status, again.json.error.code]).toEqual([409, "already_finished"]);
  expect((await call("GET", P)).json.hopsUsed).toBe(1);
  expect((await hopOn(call, project.id, c2.id, b.id)).status).toBe(201); // the project may run the next one now
});

test("hop errors: unknown card / hop / project → 404 · a worker outside the chain → 400 · a card that is not workable → 409 not_workable · bad finish body → 400", async () => {
  const { call, project, a, c1, P } = await twoCards();
  const stranger = (await call("POST", "/v1/workers", { name: "Zed", role: "BE", skills: ["x"] })).json;
  expect((await hopOn(call, project.id, "00000000-0000-0000-0000-000000000099", a.id)).status).toBe(404);
  expect((await hopOn(call, "00000000-0000-0000-0000-000000000099", c1.id, a.id)).status).toBe(404);
  const nm = await hopOn(call, project.id, c1.id, stranger.id);
  expect([nm.status, nm.json.error.code]).toEqual([400, "not_a_member"]);

  const dep = (await newCard(call, project.id, { dependsOn: [c1.id] })).json; // waits on c1
  const h0 = (await hopOn(call, project.id, c1.id, a.id)).json; // v1.5: Ann asks from her running hop on c1
  const q = (await call("POST", `/v1/cards/${c1.id}/question`, { text: "ถาม", proposedDefault: "d", cases: ["x"] }, `worker:${a.id}`, { "x-caw-hop": h0.id })).json;
  await finish(call, h0.id, "asked");
  for (const card of [dep, q]) { // waiting on a dependency · a question card
    const r = await hopOn(call, project.id, card.id, a.id);
    expect([card.number, r.status, r.json.error.code]).toEqual([card.number, 409, "not_workable"]);
  }
  await call("PATCH", `/v1/cards/${c1.id}/status`, { status: "review" });
  expect((await hopOn(call, project.id, c1.id, a.id)).json.error.code).toBe("not_workable"); // not todo / doing

  const c3 = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const h = (await hopOn(call, project.id, c3.id, a.id)).json;
  expect((await finish(call, h.id, "nope")).status).toBe(400);
  expect((await finish(call, h.id, "commented", { tokensIn: -1 })).status).toBe(400);
  expect((await finish(call, h.id, "commented", { tokensOut: 1.5 })).status).toBe(400);
  expect((await finish(call, h.id, "commented", { note: "x".repeat(2001) })).status).toBe(400);
  expect((await call("PATCH", `/v1/hops/${h.id}`, {})).status).toBe(400);
  expect((await call("PATCH", "/v1/hops/00000000-0000-0000-0000-000000000099", { outcome: "stopped" })).status).toBe(404);
  expect((await call("PATCH", "/v1/hops/not-a-uuid", { outcome: "stopped" })).status).toBe(404);
  expect((await call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/hops")).status).toBe(404);
  expect((await call("GET", `${P}/hops?limit=201`)).status).toBe(400);
});

test("budget (dispatcher only): hopsUsed ≥ hopBudget → 409 no_budget; manual mode has no limit; switching modes never resets hopsUsed", async () => {
  const { call, project, a, P } = await twoCards();
  await call("PATCH", `${P}/mode`, { mode: "dispatcher", hopBudget: 2 });
  for (let i = 0; i < 2; i++) {
    const c = (await newCard(call, project.id, { assigneeId: a.id })).json;
    const h = await hopOn(call, project.id, c.id, a.id);
    expect([i, h.status]).toEqual([i, 201]);
    await finish(call, h.json.id);
  }
  const spent = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const refused = await hopOn(call, project.id, spent.id, a.id);
  expect([refused.status, refused.json.error.code]).toEqual([409, "no_budget"]);
  expect((await call("GET", P)).json).toMatchObject({ hopsUsed: 2, hopBudget: 2 });
  await call("PATCH", `${P}/mode`, { mode: "manual" });
  expect((await call("GET", P)).json.hopsUsed).toBe(2);
  expect((await hopOn(call, project.id, spent.id, a.id)).status).toBe(201); // manual: no budget
  await call("PATCH", `${P}/mode`, { mode: "dispatcher", hopBudget: 3 }); // raising the budget lets the next one in
  const h = (await call("GET", `${P}/hops?limit=1`)).json.hops[0];
  await finish(call, h.id);
  const next = (await newCard(call, project.id, { assigneeId: a.id })).json;
  expect((await call("GET", P)).json.hopsUsed).toBe(3);
  expect((await hopOn(call, project.id, next.id, a.id)).json.error.code).toBe("no_budget");
});

test("GET hops: newest first, `limit`, `runId`", async () => {
  const { call, project, a, P } = await twoCards();
  const run = (await call("POST", `${P}/runs`, { hopBudget: 5 })).json;
  const made: string[] = [];
  for (let i = 0; i < 3; i++) {
    const c = (await newCard(call, project.id, { assigneeId: a.id })).json;
    const h = (await hopOn(call, project.id, c.id, a.id, i === 1 ? {} : { runId: run.id })).json;
    made.push(h.id);
    await finish(call, h.id);
  }
  expect((await call("GET", `${P}/hops`)).json.hops.map((h: any) => h.id)).toEqual([...made].reverse());
  expect((await call("GET", `${P}/hops?limit=2`)).json.hops.map((h: any) => h.id)).toEqual([made[2], made[1]]);
  expect((await call("GET", `${P}/hops?runId=${run.id}`)).json.hops.map((h: any) => h.id)).toEqual([made[2], made[0]]);
});

test("claim (C-Q1): set at start or once later; the same value again → 200; another → 409 already_claimed; not on a finished hop; not together with an outcome", async () => {
  const { call, project, a, c1, P } = await twoCards();
  const h = (await hopOn(call, project.id, c1.id, a.id, { claim: "runner-1" })).json;
  expect(h.claimedBy).toBe("runner-1");
  const same = await call("PATCH", `/v1/hops/${h.id}`, { claim: "runner-1" });
  expect([same.status, same.json.claimedBy]).toEqual([200, "runner-1"]);
  const other = await call("PATCH", `/v1/hops/${h.id}`, { claim: "runner-2" });
  expect([other.status, other.json.error.code]).toEqual([409, "already_claimed"]);
  expect((await call("PATCH", `/v1/hops/${h.id}`, { claim: "runner-1", outcome: "commented" })).status).toBe(400);
  expect((await call("PATCH", `/v1/hops/${h.id}`, { claim: "" })).status).toBe(400);
  await finish(call, h.id);
  expect((await call("PATCH", `/v1/hops/${h.id}`, { claim: "runner-1" })).json.error.code).toBe("already_finished");

  const c2 = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const unclaimed = (await hopOn(call, project.id, c2.id, a.id)).json;
  expect(unclaimed.claimedBy).toBeNull();
  expect((await call("PATCH", `/v1/hops/${unclaimed.id}`, { claim: "runner-9" })).json.claimedBy).toBe("runner-9");
  expect((await call("GET", `${P}/hops`)).json.hops.map((x: any) => x.claimedBy)).toEqual(["runner-9", "runner-1"]);
});

test("an orphan (a running hop claimed by another runner) is finished `interrupted` — and an interrupted hop counts in hopsUsed", async () => {
  const { call, project, a, c1, P } = await twoCards();
  const orphan = (await hopOn(call, project.id, c1.id, a.id, { claim: "runner-gone" })).json;
  const done = await finish(call, orphan.id, "interrupted", { note: "runner restarted" });
  expect(done.json).toMatchObject({ outcome: "interrupted", claimedBy: "runner-gone" });
  expect((await call("GET", P)).json.hopsUsed).toBe(1);
});

test("runs (C-Q3): open → 201 Run (mode at start, budget) · a second open one → 409 run_open · finish with stopReason + report · then a new one may start", async () => {
  const { call, project, a, P } = await twoCards();
  await call("PATCH", `${P}/mode`, { mode: "dispatcher", hopBudget: 9 });
  const r = await call("POST", `${P}/runs`, { hopBudget: 2 });
  expect(r.status).toBe(201);
  expect(r.json).toEqual({ id: r.json.id, projectId: project.id, mode: "dispatcher", hopBudget: 2, startedAt: r.json.startedAt, endedAt: null, stopReason: null, report: null, hopsUsed: 0 });
  const open = await call("POST", `${P}/runs`, { hopBudget: 1 });
  expect([open.status, open.json.error.code]).toEqual([409, "run_open"]);
  expect((await call("POST", `${P}/runs`, { hopBudget: -1 })).status).toBe(400);
  expect((await call("POST", `${P}/runs`, { hopBudget: 1.5 })).status).toBe(400);
  expect((await call("POST", "/v1/projects/00000000-0000-0000-0000-000000000099/runs", { hopBudget: 1 })).status).toBe(404);

  const R = `/v1/runs/${r.json.id}`;
  expect((await call("PATCH", R, { stopReason: "whatever", report: "x" })).status).toBe(400);
  expect((await call("PATCH", R, { stopReason: "budget_spent", report: "x".repeat(20001) })).status).toBe(400);
  expect((await call("PATCH", R, { stopReason: "budget_spent" })).status).toBe(400);
  const fin = await call("PATCH", R, { stopReason: "nothing_workable", report: "ไม่มีงานเหลือ" });
  expect(fin.status).toBe(200);
  expect(fin.json).toMatchObject({ stopReason: "nothing_workable", report: "ไม่มีงานเหลือ" });
  expect(fin.json.endedAt).toBeString();
  const twice = await call("PATCH", R, { stopReason: "error", report: "" });
  expect([twice.status, twice.json.error.code]).toEqual([409, "already_finished"]);
  expect((await call("PATCH", "/v1/runs/00000000-0000-0000-0000-000000000099", { stopReason: "error", report: "" })).status).toBe(404);
  expect((await call("POST", `${P}/runs`, { hopBudget: 3 })).status).toBe(201);
  const list = (await call("GET", `${P}/runs`)).json.runs;
  expect(list.map((x: any) => x.hopBudget)).toEqual([3, 2]); // newest first
  expect((await call("GET", `${P}/runs?limit=1`)).json.runs).toHaveLength(1);
  expect((await call("GET", `${P}/runs?limit=101`)).status).toBe(400);
  expect((await call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/runs")).status).toBe(404);
  void a;
});

test("run budget: a hop with a runId is refused 409 no_budget when that run's finished + running hops ≥ its hopBudget — in either mode; Run.hopsUsed = its finished hops", async () => {
  const { call, project, a, P } = await twoCards();
  const run = (await call("POST", `${P}/runs`, { hopBudget: 2 })).json; // the project is in manual mode: the run's budget still binds
  const doIt = async (extra: object, outcome = "commented") => {
    const c = (await newCard(call, project.id, { assigneeId: a.id })).json;
    const h = await hopOn(call, project.id, c.id, a.id, extra);
    if (h.status === 201) await finish(call, h.json.id, outcome);
    return h;
  };
  expect((await doIt({ runId: run.id })).status).toBe(201);
  expect((await call("GET", `${P}/runs`)).json.runs[0].hopsUsed).toBe(1);
  expect((await doIt({ runId: run.id }, "interrupted")).status).toBe(201);
  const spent = await doIt({ runId: run.id });
  expect([spent.status, spent.json.error.code]).toEqual([409, "no_budget"]);
  expect((await doIt({})).status).toBe(201); // a manual hop (no runId) is not part of the run
  expect((await call("GET", `${P}/runs`)).json.runs[0]).toMatchObject({ hopBudget: 2, hopsUsed: 2 });
  // a running hop counts too: budget 3 - after two finished, one running, the next is refused
  await call("PATCH", `/v1/runs/${run.id}`, { stopReason: "budget_spent", report: "" });
  const run2 = (await call("POST", `${P}/runs`, { hopBudget: 1 })).json;
  const c = (await newCard(call, project.id, { assigneeId: a.id })).json;
  const running = await hopOn(call, project.id, c.id, a.id, { runId: run2.id });
  expect(running.status).toBe(201);
  await finish(call, running.json.id);
  const c2 = (await newCard(call, project.id, { assigneeId: a.id })).json;
  expect((await hopOn(call, project.id, c2.id, a.id, { runId: run2.id })).json.error.code).toBe("no_budget");
});

test("a hop's runId must be an open run of this project: unknown → 404, a finished run → 409 already_finished", async () => {
  const { call, project, a, c1, P } = await twoCards();
  expect((await hopOn(call, project.id, c1.id, a.id, { runId: "00000000-0000-0000-0000-000000000099" })).status).toBe(404);
  const run = (await call("POST", `${P}/runs`, { hopBudget: 3 })).json;
  await call("PATCH", `/v1/runs/${run.id}`, { stopReason: "operator_stopped", report: "" });
  const r = await hopOn(call, project.id, c1.id, a.id, { runId: run.id });
  expect([r.status, r.json.error.code]).toEqual([409, "already_finished"]);
});
