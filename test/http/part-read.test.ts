// TASK-A-080 / contract v1.7: GET /v1/projects/{id}/parts/{key} — a read-only proxy to Blueprint's part context, for Team B's card-proposal screen. No actor, no write to the project.
// REQ-105 (TASK-114, SPEC-107 D4): it now reads the CURRENT spec (Blueprint's v2 route 2). The old `?version=` is still accepted and IGNORED. The fake Blueprint's v2 answers are SYNTHETIC
// (SPEC-106 v2, until recorded): the RECORDED v1 context of the chosen version, with `version`/`confirmedAt` replaced by `revision`/`savedAt`/`latestLabel` — `v2()` below does the same.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { events, specParts } from "../../src/db/schema";
import { createProject, setup } from "../helpers/api";
import { BP_PROJECT } from "../helpers/fake-blueprint";

const fix = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/blueprint/${name}.json`, import.meta.url), "utf8"));
/** the v2 answer the fake gives for a recorded context: [version, confirmedAt] out; revision, savedAt, latestLabel in */
const v2 = (name: string, spec: { revision: number; savedAt: string; label: { version: number; label: string | null } | null }) => {
  const { version: _v, confirmedAt: _c, ...rest } = fix(name);
  return { ...rest, revision: spec.revision, savedAt: spec.savedAt, latestLabel: spec.label ? { ...spec.label, labelledAt: spec.savedAt, by: "โด่ง" } : null };
};

async function world() {
  const s = await setup();
  const project = (await createProject(s.call)).json; // started from the current spec: label v1, revision 1
  return { ...s, project, P: `/v1/projects/${project.id}`, spec: () => ({ revision: s.fake.mode.spec.revision, savedAt: s.fake.mode.spec.savedAt, label: s.fake.mode.spec.label }) };
}

// was: "200: Blueprint's PartContext of STEP-004 @ v1, untouched" — now the v2 context of the current spec, and the `?version=1` is ignored
test("200: Blueprint's v2 part context of STEP-004 (the current spec), untouched; no actor needed; `?version=1` changes nothing", async () => {
  const w = await world();
  const r = await w.call("GET", `${w.P}/parts/STEP-004?version=1`, undefined, null);
  expect(r.status).toBe(200);
  expect(r.json).toEqual(v2("context-v1-step-004", w.spec()));
  expect(r.json.revision).toBe(1);
  expect(w.fake.mode.calls.at(-1)).toBe(`GET /v1/projects/${BP_PROJECT}/spec/parts/STEP-004/context`);
  expect((await w.call("GET", `${w.P}/parts/STEP-004`)).json).toEqual(r.json); // with no query, the same
});

// was: "the default version is the project's latestSeenVersion (it moves when the pull sees a newer one); an explicit version wins"
test("the read always follows the current spec: when the text and revision move, the next read has the new text — whatever `?version=` says", async () => {
  const w = await world();
  expect((await w.call("GET", `${w.P}/parts/STEP-004`)).json.part.title).toBe(fix("context-v1-step-004").part.title);
  w.fake.mode.spec.version = 2; w.fake.mode.spec.revision = 2; // Blueprint's spec moved on (a synthetic edit: the recorded v2 text of the part)
  const now = await w.call("GET", `${w.P}/parts/STEP-004?version=1`); // an old caller still asking for version 1 gets the CURRENT text
  expect(now.json).toEqual(v2("context-v2-step-004", w.spec()));
  expect(now.json.part.title).toBe(fix("context-v2-step-004").part.title);
  expect(now.json.part.title).not.toBe(fix("context-v1-step-004").part.title);
  expect(w.fake.mode.calls.at(-1)).toBe(`GET /v1/projects/${BP_PROJECT}/spec/parts/STEP-004/context`); // never a /versions/N route
});

// was: "…version=0 / abc / 1.5 → 400", and `?version=9` → 404. 0 is accepted now (ignored); a version Blueprint never had does not matter any more
test("errors: a part not in the current spec → 404 part_not_found · unknown project → 404 · version=abc / 1.5 / -1 → 400 (version=0 and =9 are ignored) · Blueprint down with nothing read → 502", async () => {
  const w = await world();
  const nope = await w.call("GET", `${w.P}/parts/NOPE-999?version=1`);
  expect([nope.status, nope.json.error.code]).toEqual([404, "part_not_found"]);
  expect((await w.call("GET", `${w.P}/parts/STEP-004?version=9`)).status).toBe(200); // was 404: no "version 9" to be missing
  expect((await w.call("GET", `${w.P}/parts/STEP-004?version=0`)).status).toBe(200); // was 400
  const noProject = await w.call("GET", "/v1/projects/00000000-0000-0000-0000-000000000099/parts/STEP-004");
  expect([noProject.status, noProject.json.error.code]).toEqual([404, "not_found"]);
  expect((await w.call("GET", "/v1/projects/not-a-uuid/parts/STEP-004")).status).toBe(404);
  for (const v of ["abc", "1.5", "-1"]) expect([v, (await w.call("GET", `${w.P}/parts/STEP-004?version=${v}`)).status]).toEqual([v, 400]);
  // nothing has been read for STEP-005 yet, so with Blueprint down there is no cache to serve → 502 as before
  w.fake.mode.down = true;
  const down = await w.call("GET", `${w.P}/parts/STEP-005`);
  expect([down.status, down.json.error.code]).toEqual([502, "blueprint_unreachable"]);
});

test("a part read once is served from the last body read when Blueprint is down (SPEC-107 D4, AC-5), and the cache forgets a part Blueprint says is gone", async () => {
  const w = await world();
  const live = await w.call("GET", `${w.P}/parts/STEP-004`);
  w.fake.mode.down = true;
  const cached = await w.call("GET", `${w.P}/parts/STEP-004`);
  expect([cached.status, cached.json]).toEqual([200, live.json]);
  w.fake.mode.down = false;
  w.fake.mode.gone.add("STEP-004"); // the part was removed from the spec
  expect((await w.call("GET", `${w.P}/parts/STEP-004`)).status).toBe(404);
  expect(await w.db.select().from(specParts)).toEqual([]); // and its saved body went with it
  w.fake.mode.down = true;
  expect((await w.call("GET", `${w.P}/parts/STEP-004`)).status).toBe(502); // so a later outage cannot bring a removed part back
});

// was: "read-only: the event count and every table are the same after the calls". A read now SAVES the body it read (spec_parts, operational, not an event): the events are still unchanged.
test("read-only for the project: the event count is the same after the calls (a read saves the body in spec_parts, which is not an event); a key with odd characters is passed on encoded", async () => {
  const w = await world();
  const count = async () => (await w.db.select().from(events)).length;
  const before = await count();
  await w.call("GET", `${w.P}/parts/STEP-004?version=1`);
  await w.call("GET", `${w.P}/parts/NOPE-999`);
  await w.call("GET", `${w.P}/parts/${encodeURIComponent("ก/ข?x")}?version=1`);
  expect(await count()).toBe(before);
  expect((await w.db.select().from(specParts)).map((r) => r.key)).toEqual(["STEP-004"]); // only the part that exists was saved
  expect(w.fake.mode.calls.at(-1)).toBe(`GET /v1/projects/${BP_PROJECT}/spec/parts/${encodeURIComponent("ก/ข?x")}/context`);
});
