// TASK-A-077 (contract v1.2): the `runner:<name>` actor — Team C's runner, an instance named in `X-CAW-Actor`. It may write exactly
// four routes (open / finish a run, start / finish-or-claim a hop); on any other write → 403 runner_not_allowed; a malformed
// name → 400 actor_required. Stored on the event as given. The operator and workers keep working on those four routes.
import { expect, test } from "bun:test";
import { events } from "../../src/db/schema";
import { chainOf3, newCard, setup, type Call } from "../helpers/api";

const R = "runner:r-1";

async function world() {
  const s = await setup();
  const chain = await chainOf3(s.call);
  const card = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id })).json;
  return { ...s, ...chain, card, P: `/v1/projects/${chain.project.id}` };
}

test("a runner opens and finishes a run, starts + claims + finishes a hop: 201 / 200, and every event carries the actor as given", async () => {
  const { call, db, project, a, card, P } = await world();
  const run = await call("POST", `${P}/runs`, { hopBudget: 3 }, R);
  expect(run.status).toBe(201);
  const hop = await call("POST", `${P}/hops`, { cardId: card.id, workerId: a.id, runId: run.json.id }, R);
  expect(hop.status).toBe(201);
  const claimed = await call("PATCH", `/v1/hops/${hop.json.id}`, { claim: "r-1" }, R);
  expect([claimed.status, claimed.json.claimedBy]).toEqual([200, "r-1"]);
  const done = await call("PATCH", `/v1/hops/${hop.json.id}`, { outcome: "commented", tokensIn: 5, tokensOut: 2 }, R);
  expect([done.status, done.json.outcome]).toEqual([200, "commented"]);
  const fin = await call("PATCH", `/v1/runs/${run.json.id}`, { stopReason: "nothing_workable", report: "จบ" }, R);
  expect([fin.status, fin.json.stopReason]).toEqual([200, "nothing_workable"]);

  const runnerEvents = (await db.select().from(events)).filter((e) => e.actor === R).map((e) => e.type);
  expect(runnerEvents).toEqual(["run.started", "hop.started", "hop.claimed", "hop.finished", "run.finished"]);
  expect((await call("POST", `${P.replace("/v1", "/v1")}/rebuild-check`, undefined, null)).json).toEqual({ same: true });
  void project;
});

test("every other write answers 403 runner_not_allowed — cards, mode, workspace, workers, chain, comments, status, questions, assignee", async () => {
  const { call, project, a, b, card, P } = await world();
  const all: [string, string, unknown][] = [
    ["POST", `${P}/cards`, { title: "t", todo: "", anchor: { key: "STEP-004", version: 1 } }],
    ["PATCH", `${P}/mode`, { mode: "dispatcher" }],
    ["PATCH", `${P}/workspace`, { roots: ["/x"] }],
    ["POST", "/v1/workers", { name: "n", role: "BE", skills: ["s"] }],
    ["POST", "/v1/workers/combine", { name: "n", workerIds: [a.id, b.id] }],
    ["POST", `${P}/chain/members`, { workerId: a.id }],
    ["POST", `${P}/chain/edges`, { from: a.id, to: b.id }],
    ["DELETE", `${P}/chain/members/${a.id}`, undefined],
    ["PUT", `${P}/chain/entry`, { workerId: a.id }],
    ["POST", `/v1/cards/${card.id}/comments`, { text: "x" }],
    ["POST", `/v1/cards/${card.id}/handoff`, { toWorkerId: b.id, text: "x" }],
    ["PATCH", `/v1/cards/${card.id}/status`, { status: "doing" }],
    ["PATCH", `/v1/cards/${card.id}/assignee`, { workerId: b.id }],
    ["POST", `/v1/cards/${card.id}/question`, { text: "q", proposedDefault: "d", cases: ["c"] }],
    ["POST", `/v1/cards/${card.id}/answer`, { answer: "a" }],
    ["POST", `/v1/cards/${card.id}/spec-change/clear`, undefined],
    ["POST", "/v1/projects", { blueprintProjectId: "x", version: 1 }],
  ];
  for (const [method, path, body] of all) {
    const r = await call(method, path, body, R);
    expect([method, path.replace(/[0-9a-f-]{36}/g, ":id"), r.status, r.json.error?.code]).toEqual([method, path.replace(/[0-9a-f-]{36}/g, ":id"), 403, "runner_not_allowed"]);
  }
  expect((await call("GET", `${P}/cards`)).json.cards).toHaveLength(1); // none of them wrote anything
  expect((await call("GET", `/v1/projects/${project.id}`)).json).toMatchObject({ mode: "manual", workspace: { roots: [] } });
});

test("a malformed runner name is 400 actor_required (even on a route a runner may not use): `runner:`, spaces, symbols, 65 characters", async () => {
  const { call, P } = await world();
  for (const actor of ["runner:", "runner:bad name", "runner:a/b", "runner:é", `runner:${"x".repeat(65)}`, "runner:a:b", "Runner:r-1", "runner"]) {
    for (const path of [`${P}/runs`, `${P}/mode`]) {
      const r = await call(path.endsWith("runs") ? "POST" : "PATCH", path, path.endsWith("runs") ? { hopBudget: 1 } : { mode: "manual" }, actor);
      expect([actor, path.slice(-4), r.status, r.json.error.code]).toEqual([actor, path.slice(-4), 400, "actor_required"]);
    }
  }
  for (const ok of ["runner:r", "runner:R_1-b", `runner:${"x".repeat(64)}`, "runner:0"]) {
    expect([ok, (await call("POST", `${P}/runs`, { hopBudget: 1 }, ok)).status]).toEqual([ok, 201]);
    const open = (await call("GET", `${P}/runs`)).json.runs[0];
    await call("PATCH", `/v1/runs/${open.id}`, { stopReason: "operator_stopped", report: "" }, ok); // free the one open run for the next
  }
});

test("the operator and a worker still work on the four routes", async () => {
  const { call, a, card, P } = await world();
  const opRun = await call("POST", `${P}/runs`, { hopBudget: 2 }, "operator");
  expect(opRun.status).toBe(201);
  const hop = await call("POST", `${P}/hops`, { cardId: card.id, workerId: a.id, runId: opRun.json.id }, `worker:${a.id}`);
  expect(hop.status).toBe(201);
  expect((await call("PATCH", `/v1/hops/${hop.json.id}`, { outcome: "stopped" }, "operator")).status).toBe(200);
  expect((await call("PATCH", `/v1/runs/${opRun.json.id}`, { stopReason: "operator_stopped", report: "" }, `worker:${a.id}`)).status).toBe(200);
});

test("reads and the two actor-less routes are unaffected by a runner header", async () => {
  const { call, P } = await world();
  const callAs = (method: string, path: string, body?: unknown, actor?: string | null) => (call as Call)(method, path, body, actor);
  expect((await callAs("GET", `${P}/cards`, undefined, R)).status).toBe(200); // a read needs no actor
  expect((await callAs("POST", `${P}/rebuild-check`, undefined, R)).status).toBe(200); // writes nothing: no actor rule
  expect((await callAs("POST", "/v1/notify", { event: "version.confirmed", projectId: "nobody", version: 1, confirmedAt: "x" }, R)).status).toBe(202);
});
