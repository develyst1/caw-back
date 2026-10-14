// ProjectWatch: what the runner learns from a project's events — pure, fed scripted event lists.
import { describe, expect, test } from "bun:test";
import type { ApiEvent } from "./api";
import { ProjectWatch } from "./watch";

let seq = 0;
const ev = (type: string, data: object, actor = "operator"): ApiEvent => ({ seq: ++seq, projectId: "p", type, actor, at: "t", data });
const set = (cardId: string, status: string, actor = "operator") => ev("card.status_set", { cardId, status }, actor);
const watchOf = (...events: ApiEvent[]) => { const w = new ProjectWatch(); w.fold(events); return w; };

describe("fold", () => {
  test("the cursor is the last seq seen, so the next read starts after it", () => {
    const w = watchOf(ev("project.created", {}), ev("card.created", { id: "c1" }));
    expect(w.cursor).toBe(seq);
  });
  test("run start / end seqs and the newest switch to dispatcher are remembered", () => {
    const start = ev("run.started", { id: "r1" });
    const mode = ev("project.mode_set", { mode: "dispatcher" });
    const end = ev("run.finished", { runId: "r1", stopReason: "nothing_workable" });
    const w = watchOf(start, mode, end);
    expect([w.runStartSeq.get("r1"), w.runEndSeq.get("r1"), w.modeSetSeq]).toEqual([start.seq, end.seq, mode.seq]);
  });
  test("a switch to MANUAL is not a reason to open a run", () => {
    const w = watchOf(ev("run.finished", { runId: "r1" }), ev("project.mode_set", { mode: "manual" }));
    expect(w.switchedSince("r1")).toBe(false);
  });
});

describe("switchedSince — may a new run open?", () => {
  test("the operator switched to dispatcher AFTER the run ended → yes", () => {
    expect(watchOf(ev("run.finished", { runId: "r1" }), ev("project.mode_set", { mode: "dispatcher" })).switchedSince("r1")).toBe(true);
  });
  test("the switch came BEFORE the run ended → no (the run is over, nobody asked again)", () => {
    expect(watchOf(ev("project.mode_set", { mode: "dispatcher" }), ev("run.finished", { runId: "r1" })).switchedSince("r1")).toBe(false);
  });
  test("a run that never produced a run.finished event → no (never guess)", () => {
    expect(watchOf(ev("project.mode_set", { mode: "dispatcher" })).switchedSince("r9")).toBe(false);
  });
});

describe("reviewFailedIn — the same card sent back from review twice (REQ-012 R6)", () => {
  const run = () => ev("run.started", { id: "r1" });
  test("review → todo, then review → doing, both after the run started → that card", () => {
    const w = watchOf(run(), set("c1", "review"), set("c1", "todo"), set("c1", "review"), set("c1", "doing"));
    expect(w.reviewFailedIn("r1")).toBe("c1");
  });
  test("sent back once → no", () => {
    expect(watchOf(run(), set("c1", "review"), set("c1", "todo")).reviewFailedIn("r1")).toBeNull();
  });
  test("the status before is replayed from the card's own events: todo → doing is not a send-back, review → done is not", () => {
    const w = watchOf(run(), set("c1", "doing"), set("c1", "todo"), set("c1", "doing"), set("c1", "review"), set("c1", "done"));
    expect(w.reviewFailedIn("r1")).toBeNull();
  });
  test("two cards, one send-back each → no (it must be the SAME card)", () => {
    const w = watchOf(run(), set("c1", "review"), set("c1", "todo"), set("c2", "review"), set("c2", "todo"));
    expect(w.reviewFailedIn("r1")).toBeNull();
  });
  test("send-backs of an EARLIER run do not count: twice means twice DURING this run", () => {
    const early = [set("c1", "review"), set("c1", "todo"), set("c1", "review"), set("c1", "doing")];
    expect(watchOf(...early, run()).reviewFailedIn("r1")).toBeNull();
    expect(watchOf(...early, run(), set("c1", "review"), set("c1", "todo")).reviewFailedIn("r1")).toBeNull();          // one now, two before
    expect(watchOf(set("c1", "review"), set("c1", "todo"), run(), set("c1", "review"), set("c1", "todo")).reviewFailedIn("r1")).toBeNull(); // one before, one now
    expect(watchOf(...early, run(), set("c1", "review"), set("c1", "todo"), set("c1", "review"), set("c1", "todo")).reviewFailedIn("r1")).toBe("c1"); // two now
  });
  test("folding the same events twice (two readers racing on one cursor) changes nothing", () => {
    const events = [run(), set("c1", "doing"), set("c1", "review"), set("c1", "todo")];
    const w = new ProjectWatch();
    w.fold(events); w.fold(events);
    expect(w.reviewFailedIn("r1")).toBeNull();                                  // ONE send-back, not two
    w.fold([...events, set("c1", "review"), set("c1", "todo")]);                 // an overlapping read that adds a second one
    expect(w.reviewFailedIn("r1")).toBe("c1");
  });
  test("any actor counts — the reviewer is usually the operator, not a worker", () => {
    const w = watchOf(run(), set("c1", "review", "worker:w"), set("c1", "todo", "operator"), set("c1", "review", "worker:w"), set("c1", "todo", "runner:x"));
    expect(w.reviewFailedIn("r1")).toBe("c1");
  });
  test("a run the watch never saw start → null", () => {
    expect(watchOf(set("c1", "review"), set("c1", "todo")).reviewFailedIn("r1")).toBeNull();
  });
});
