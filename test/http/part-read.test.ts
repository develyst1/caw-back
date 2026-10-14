// TASK-A-080 / contract v1.7: GET /v1/projects/{id}/parts/{key}?version= — a read-only proxy to Blueprint's part context, for Team B's
// card-proposal screen. No actor, no write, no table. The fake Blueprint serves RECORDED answers of a real blueprint-back.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { events } from "../../src/db/schema";
import { createProject, setup } from "../helpers/api";
import { BP_PROJECT } from "../helpers/fake-blueprint";

const fix = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/blueprint/${name}.json`, import.meta.url), "utf8"));

async function world() {
  const s = await setup();
  const project = (await createProject(s.call)).json; // made from v1 → latestSeenVersion 1
  return { ...s, project, P: `/v1/projects/${project.id}` };
}

test("200: Blueprint's PartContext of STEP-004 @ v1, untouched; no actor needed", async () => {
  const w = await world();
  const r = await w.call("GET", `${w.P}/parts/STEP-004?version=1`, undefined, null);
  expect(r.status).toBe(200);
  expect(r.json).toEqual(fix("context-v1-step-004"));
  expect(w.fake.mode.calls.at(-1)).toBe(`GET /v1/projects/${BP_PROJECT}/versions/1/parts/STEP-004/context`);
});

test("the default version is the project's latestSeenVersion (it moves when the pull sees a newer one); an explicit version wins", async () => {
  const w = await world();
  const noQuery = await w.call("GET", `${w.P}/parts/STEP-004`);
  expect(noQuery.json).toEqual(fix("context-v1-step-004")); // latestSeenVersion 1
  expect(w.fake.mode.calls.at(-1)).toContain("/versions/1/parts/");
  await w.follow.pullAll(); // the recorded feed has v2 and v3 → latestSeenVersion 3
  expect((await w.call("GET", `${w.P}`)).json.latestSeenVersion).toBe(3);
  await w.call("GET", `${w.P}/parts/STEP-004`);
  expect(w.fake.mode.calls.at(-1)).toContain("/versions/3/parts/STEP-004/context"); // the default followed it
  const v2 = await w.call("GET", `${w.P}/parts/STEP-004?version=2`);
  expect([v2.status, w.fake.mode.calls.at(-1)]).toEqual([200, `GET /v1/projects/${BP_PROJECT}/versions/2/parts/STEP-004/context`]);
  expect(v2.json).toEqual(fix("context-v2-step-004"));
});

test("errors: a part Blueprint does not have → 404 part_not_found · unknown project → 404 · version=0 / abc / 1.5 → 400 · Blueprint down → 502", async () => {
  const w = await world();
  const nope = await w.call("GET", `${w.P}/parts/NOPE-999?version=1`);
  expect([nope.status, nope.json.error.code]).toEqual([404, "part_not_found"]);
  const noVersion = await w.call("GET", `${w.P}/parts/STEP-004?version=9`); // a version Blueprint does not have: the same answer
  expect([noVersion.status, noVersion.json.error.code]).toEqual([404, "part_not_found"]);
  const noProject = await w.call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/parts/STEP-004");
  expect([noProject.status, noProject.json.error.code]).toEqual([404, "not_found"]);
  expect((await w.call("GET", "/v1/projects/not-a-uuid/parts/STEP-004")).status).toBe(404);
  for (const v of ["0", "abc", "1.5", "-1"]) expect([v, (await w.call("GET", `${w.P}/parts/STEP-004?version=${v}`)).status]).toEqual([v, 400]);
  w.fake.mode.down = true;
  const down = await w.call("GET", `${w.P}/parts/STEP-004?version=1`);
  expect([down.status, down.json.error.code]).toEqual([502, "blueprint_unreachable"]);
});

test("read-only: the event count and every table are the same after the calls; a key with odd characters is passed on encoded", async () => {
  const w = await world();
  const count = async () => (await w.db.select().from(events)).length;
  const before = await count();
  await w.call("GET", `${w.P}/parts/STEP-004?version=1`);
  await w.call("GET", `${w.P}/parts/NOPE-999`);
  await w.call("GET", `${w.P}/parts/${encodeURIComponent("ก/ข?x")}?version=1`);
  expect(await count()).toBe(before);
  expect(w.fake.mode.calls.at(-1)).toBe(`GET /v1/projects/${BP_PROJECT}/versions/1/parts/${encodeURIComponent("ก/ข?x")}/context`);
});
