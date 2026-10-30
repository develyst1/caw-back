// planTick: the decision of one automatic tick, as a pure function (mode × open run × hop running × workable × budget).
import { describe, expect, test } from "bun:test";
import type { HopOutcome } from "./api";
import { type PlanInput, planTick } from "./plan";

const card = (number: number, over: Partial<PlanInput["workable"][number]> = {}) => ({ id: `c${number}`, number, assigneeId: "w1", ...over });
const run = (over: object = {}) => ({ id: "r1", hopBudget: 3, endedAt: null as string | null, ...over });
const hop = (cardId: string, outcome: HopOutcome | null, over: object = {}) => ({ id: `h-${cardId}-${outcome}`, cardId, workerId: "w1", runId: "r1", outcome, endedAt: outcome === null ? null : "t", ...over });
const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  mode: "dispatcher", openRun: run(), runCanReopen: false, hopRunning: false, reviewFailed: null, pendingMessage: null, entryWorkerId: "entry", workable: [card(1), card(2)], hopsInRun: [], ...over,
});

describe("manual mode", () => {
  test("no open run → nothing to do", () => {
    expect(planTick(base({ mode: "manual", openRun: null }))).toEqual({ kind: "idle" });
  });
  test("an open run → it is finished, operator_stopped (a hop still running is NOT touched)", () => {
    expect(planTick(base({ mode: "manual", hopRunning: true }))).toEqual({ kind: "finish_run", runId: "r1", reason: "operator_stopped" });
  });
});

describe("automatic mode — no open run", () => {
  test("a project that never had a run, or whose last run ended BEFORE the operator switched again → open one", () => {
    expect(planTick(base({ openRun: null, runCanReopen: true }))).toEqual({ kind: "open_run" });
  });
  test("the last run ended and nobody switched since → stay idle, or a run would open and end every tick", () => {
    expect(planTick(base({ openRun: null, runCanReopen: false }))).toEqual({ kind: "idle" });
  });
});

describe("automatic mode — an open run", () => {
  test("a hop is running → one at a time: nothing", () => {
    expect(planTick(base({ hopRunning: true }))).toEqual({ kind: "idle" });
  });
  test("none running → the lowest-numbered workable card, with its assignee", () => {
    expect(planTick(base({ workable: [card(2), card(1, { assigneeId: "w9" })] }))).toEqual({ kind: "start_hop", cardId: "c1", workerId: "w9" });
  });
  test("workable is in the API's order, but the lowest NUMBER wins regardless", () => {
    expect(planTick(base({ workable: [card(5), card(3), card(4)] }))).toEqual({ kind: "start_hop", cardId: "c3", workerId: "w1" });
  });
  test("a card with no assignee has no worker: skipped, the next one is taken", () => {
    expect(planTick(base({ workable: [card(1, { assigneeId: null }), card(2)] }))).toEqual({ kind: "start_hop", cardId: "c2", workerId: "w1" });
  });
  test("nothing workable → the run ends: nothing_workable", () => {
    expect(planTick(base({ workable: [] }))).toEqual({ kind: "finish_run", runId: "r1", reason: "nothing_workable" });
  });
  test("only cards without an assignee → also nothing_workable", () => {
    expect(planTick(base({ workable: [card(1, { assigneeId: null })] }))).toEqual({ kind: "finish_run", runId: "r1", reason: "nothing_workable" });
  });
  test("the run's budget is spent (its hops ≥ hopBudget) → budget_spent, before asking for another hop", () => {
    const hops = [hop("c1", "commented"), hop("c2", "commented"), hop("c3", "failed")];
    expect(planTick(base({ hopsInRun: hops }))).toEqual({ kind: "finish_run", runId: "r1", reason: "budget_spent" });
  });
  test("a budget of 0 → budget_spent at once", () => {
    expect(planTick(base({ openRun: run({ hopBudget: 0 }) }))).toEqual({ kind: "finish_run", runId: "r1", reason: "budget_spent" });
  });
});

describe("which cards are taken again within one run (a failed card must not be hopped in a loop)", () => {
  test("a card whose hop FAILED or was STOPPED is left where it is: the next card is taken", () => {
    for (const outcome of ["failed", "stopped"] as const) {
      expect(planTick(base({ hopsInRun: [hop("c1", outcome)] }))).toEqual({ kind: "start_hop", cardId: "c2", workerId: "w1" });
    }
  });
  test("a card already hopped by this worker in this run (even `commented`, status unchanged) is not hopped again", () => {
    expect(planTick(base({ hopsInRun: [hop("c1", "commented")] }))).toEqual({ kind: "start_hop", cardId: "c2", workerId: "w1" });
  });
  test("an INTERRUPTED hop does not count: that card is still owed its turn", () => {
    expect(planTick(base({ workable: [card(1)], hopsInRun: [hop("c1", "interrupted")] }))).toEqual({ kind: "start_hop", cardId: "c1", workerId: "w1" });
  });
  test("the same card for a DIFFERENT worker (handed off) is a new turn", () => {
    expect(planTick(base({ workable: [card(1, { assigneeId: "w2" })], hopsInRun: [hop("c1", "handed_off")] }))).toEqual({ kind: "start_hop", cardId: "c1", workerId: "w2" });
  });
  test("the only card, commented once → it gets a second turn (SPEC-116 D1)", () => {
    expect(planTick(base({ workable: [card(1)], hopsInRun: [hop("c1", "commented")], openRun: run({ hopBudget: 9 }) }))).toEqual({ kind: "start_hop", cardId: "c1", workerId: "w1" });
  });
  test("commented twice and still workable → no_progress, naming the card", () => {
    const hops = [hop("c1", "commented", { id: "a" }), hop("c1", "commented", { id: "b" })];
    expect(planTick(base({ workable: [card(1)], hopsInRun: hops, openRun: run({ hopBudget: 9 }) }))).toEqual({ kind: "finish_run", runId: "r1", reason: "no_progress", cardId: "c1" });
  });
  test("failed once on the only card → no_progress (a failing card is not hopped again)", () => {
    expect(planTick(base({ workable: [card(1)], hopsInRun: [hop("c1", "failed")], openRun: run({ hopBudget: 9 }) }))).toEqual({ kind: "finish_run", runId: "r1", reason: "no_progress", cardId: "c1" });
  });
  test("c1 commented once and c2 untouched → c2 goes first, c1's second turn after", () => {
    const hops = [hop("c1", "commented")];
    expect(planTick(base({ hopsInRun: hops, openRun: run({ hopBudget: 9 }) }))).toEqual({ kind: "start_hop", cardId: "c2", workerId: "w1" });
    expect(planTick(base({ hopsInRun: [...hops, hop("c2", "failed")], openRun: run({ hopBudget: 9 }) }))).toEqual({ kind: "start_hop", cardId: "c1", workerId: "w1" });
  });
  test("several stuck cards → the lowest-numbered is the one named", () => {
    const hops = [hop("c2", "failed"), hop("c1", "failed")];
    expect(planTick(base({ workable: [card(2), card(1)], hopsInRun: hops, openRun: run({ hopBudget: 9 }) }))).toEqual({ kind: "finish_run", runId: "r1", reason: "no_progress", cardId: "c1" });
  });
  test("a stuck card without an assignee is not named: nothing_workable", () => {
    expect(planTick(base({ workable: [card(1, { assigneeId: null })], openRun: run({ hopBudget: 9 }) }))).toEqual({ kind: "finish_run", runId: "r1", reason: "nothing_workable" });
  });
});

describe("a card sent back from review twice (REQ-012 R6)", () => {
  test("the run ends failed_review_twice, ahead of picking another card", () => {
    expect(planTick(base({ reviewFailed: "c1" }))).toEqual({ kind: "finish_run", runId: "r1", reason: "failed_review_twice" });
  });
  test("even while a hop is running — the hop finishes on its own, only the run ends (as with operator_stopped)", () => {
    expect(planTick(base({ reviewFailed: "c1", hopRunning: true }))).toEqual({ kind: "finish_run", runId: "r1", reason: "failed_review_twice" });
  });
  test("manual mode ignores it (the operator stopped the run already)", () => {
    expect(planTick(base({ mode: "manual", reviewFailed: "c1" }))).toEqual({ kind: "finish_run", runId: "r1", reason: "operator_stopped" });
  });
  test("with no open run it does nothing", () => {
    expect(planTick(base({ openRun: null, reviewFailed: "c1" }))).toEqual({ kind: "idle" });
  });
});

describe("a chat message is the operator\'s go for one chat hop, in either mode (D-053 Q-A)", () => {
  const msg = { id: "m1" };
  test("manual mode, nothing running → a chat hop for the entry worker (no run, no card)", () => {
    expect(planTick(base({ mode: "manual", openRun: null, pendingMessage: msg }))).toEqual({ kind: "start_chat_hop", messageId: "m1", workerId: "entry" });
  });
  test("dispatcher with an open run → the chat message goes BEFORE any card (the operator is waiting)", () => {
    expect(planTick(base({ pendingMessage: msg }))).toEqual({ kind: "start_chat_hop", messageId: "m1", workerId: "entry" });
  });
  test("dispatcher with NO open run and no reason to open one → still the chat hop (typing is the go, not the mode)", () => {
    expect(planTick(base({ openRun: null, runCanReopen: false, pendingMessage: msg }))).toEqual({ kind: "start_chat_hop", messageId: "m1", workerId: "entry" });
  });
  test("it waits for a running hop, card or chat — one hop at a time per project", () => {
    expect(planTick(base({ hopRunning: true, pendingMessage: msg }))).toEqual({ kind: "idle" });
    expect(planTick(base({ mode: "manual", openRun: null, hopRunning: true, pendingMessage: msg }))).toEqual({ kind: "idle" });
  });
  test("no entry worker → no chat hop (main logs it once per message); the cards go on", () => {
    expect(planTick(base({ pendingMessage: msg, entryWorkerId: null }))).toEqual({ kind: "start_hop", cardId: "c1", workerId: "w1" });
    expect(planTick(base({ mode: "manual", openRun: null, pendingMessage: msg, entryWorkerId: null }))).toEqual({ kind: "idle" });
  });
  test("a chat hop does not touch the run: it is taken even when the run\'s budget is spent", () => {
    const spent = [1, 2, 3].map((n) => ({ cardId: `c${n}`, workerId: "w1", outcome: "commented" as const }));
    expect(planTick(base({ pendingMessage: msg, hopsInRun: spent }))).toEqual({ kind: "start_chat_hop", messageId: "m1", workerId: "entry" });
  });
  test("manual mode with a run still open: the run is closed first (as before), the chat hop comes on the next tick", () => {
    expect(planTick(base({ mode: "manual", pendingMessage: msg }))).toEqual({ kind: "finish_run", runId: "r1", reason: "operator_stopped" });
  });
  test("a run that must end (a card sent back twice) ends first", () => {
    expect(planTick(base({ pendingMessage: msg, reviewFailed: "c1" }))).toEqual({ kind: "finish_run", runId: "r1", reason: "failed_review_twice" });
  });
});
