// REQ-105 (SPEC-107 D8, TASK-115): POST /v1/notify takes three kinds on one URL — version.confirmed (as before), spec.changed, and any other event string
// (accepted, ignored). Whether "a pull ran" is read off the fake Blueprint's call log: a pull asks `/spec/changes`.
import { expect, test } from "bun:test";
import { createProject, setup } from "../helpers/api";
import { BP_PROJECT } from "../helpers/fake-blueprint";

async function world() {
  const s = await setup();
  const project = (await createProject(s.call)).json;
  const notify = async (body: unknown) => {
    const r = await s.call("POST", "/v1/notify", body, null); // Blueprint sends no actor
    await s.follow.idle();
    return r;
  };
  const pulls = () => s.fake.mode.calls.filter((c) => c.includes("/spec/changes")).length;
  return { ...s, project, notify, pulls };
}

test("spec.changed { projectId, revision ≥ 0, at } → 202 {} and the pull for that Blueprint project runs", async () => {
  const w = await world();
  for (const revision of [12, 0]) {
    const before = w.pulls();
    const r = await w.notify({ event: "spec.changed", projectId: BP_PROJECT, revision, at: "2026-10-29T07:00:00Z" });
    expect([r.status, r.json]).toEqual([202, {}]);
    expect(w.pulls()).toBe(before + 1);
  }
});

test("version.confirmed { projectId, version ≥ 1, confirmedAt } → 202 {} and the pull runs, exactly as before", async () => {
  const w = await world();
  const before = w.pulls();
  const r = await w.notify({ event: "version.confirmed", projectId: BP_PROJECT, version: 2, confirmedAt: "2026-10-13T10:00:00.000Z" });
  expect([r.status, r.json]).toEqual([202, {}]);
  expect(w.pulls()).toBe(before + 1);
});

test("any OTHER event string with a projectId → 202 {} and NO pull (a Blueprint that grows a notice must not get a 400)", async () => {
  const w = await world();
  const before = w.fake.mode.calls.length;
  for (const body of [{ event: "something.else", projectId: BP_PROJECT }, { event: "label.added", projectId: BP_PROJECT, label: "v2", extra: 1 }]) {
    const r = await w.notify(body);
    expect([JSON.stringify(body), r.status, r.json]).toEqual([JSON.stringify(body), 202, {}]);
  }
  expect(w.fake.mode.calls.length).toBe(before);
});

test("a Blueprint project CAW does not follow → 202 and no call to Blueprint, for both known kinds", async () => {
  const w = await world();
  const before = w.fake.mode.calls.length;
  expect((await w.notify({ event: "spec.changed", projectId: "nobody", revision: 3, at: "x" })).status).toBe(202);
  expect((await w.notify({ event: "version.confirmed", projectId: "nobody", version: 3, confirmedAt: "x" })).status).toBe(202);
  expect(w.fake.mode.calls.length).toBe(before);
});

test("a body that is no notice → 400, and no pull: no string `event` / `projectId`, or a known kind with a bad field", async () => {
  const w = await world();
  const before = w.fake.mode.calls.length;
  const bad: unknown[] = [
    {}, [], { projectId: BP_PROJECT }, { event: "something.else" }, { event: 5, projectId: BP_PROJECT }, { event: "something.else", projectId: "" },
    { event: "spec.changed", projectId: BP_PROJECT, at: "x" }, // no revision
    { event: "spec.changed", projectId: BP_PROJECT, revision: -1, at: "x" },
    { event: "spec.changed", projectId: BP_PROJECT, revision: 1.5, at: "x" },
    { event: "spec.changed", projectId: BP_PROJECT, revision: 1 }, // no `at`
    { event: "spec.changed", revision: 1, at: "x" }, // no projectId
    { event: "version.confirmed", projectId: BP_PROJECT }, // the recorded 400: the v1 body must still be complete
    { event: "version.confirmed", projectId: BP_PROJECT, version: 0, confirmedAt: "x" },
    { event: "version.confirmed", version: 3, confirmedAt: "x" },
  ];
  for (const body of bad) expect([JSON.stringify(body), (await w.notify(body)).status]).toEqual([JSON.stringify(body), 400]);
  expect(w.fake.mode.calls.length).toBe(before);
});
