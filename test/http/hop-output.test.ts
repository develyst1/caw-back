// REQ-104 / SPEC-103 § API: what a hop's CLI showed. POST /v1/hops/{hopId}/output is the runner's (batches of 1–200, a repeated (hop, seq) is skipped),
// GET reads it for any actor (after / limit / more, ascending). The rows stay after the hop has finished; they are not events, so a rebuild is unaffected.
import { expect, test } from "bun:test";
import { chainOf3, newCard, setup } from "../helpers/api";

async function world() {
  const s = await setup();
  const chain = await chainOf3(s.call);
  const card = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id })).json;
  const hop = (await s.call("POST", `/v1/projects/${chain.project.id}/hops`, { cardId: card.id, workerId: chain.a.id })).json as { id: string };
  const entry = (seq: number, over: object = {}) => ({ seq, at: `2026-10-29T10:00:${String(seq % 60).padStart(2, "0")}.000Z`, kind: "line", text: `line ${seq}`, ...over });
  const post = (entries: unknown, id = hop.id, actor: string | null = "runner:r1") => s.call("POST", `/v1/hops/${id}/output`, { entries }, actor);
  const get = (query = "", id = hop.id, actor: string | null = "operator") => s.call("GET", `/v1/hops/${id}/output${query}`, undefined, actor);
  return { ...s, ...chain, hop, entry, post, get, P: `/v1/projects/${chain.project.id}` };
}
const NO_HOP = "00000000-0000-4000-8000-000000000099";

test("a runner posts a batch → 202 { stored: n }; the same batch again → { stored: 0 } and nothing doubles", async () => {
  const w = await world();
  const batch = [w.entry(0), w.entry(1), w.entry(2)];
  const first = await w.post(batch);
  expect([first.status, first.json]).toEqual([202, { stored: 3 }]);
  const again = await w.post(batch);
  expect([again.status, again.json]).toEqual([202, { stored: 0 }]);
  const mixed = await w.post([w.entry(2), w.entry(3)]);
  expect(mixed.json).toEqual({ stored: 1 }); // only the new seq counts
  expect((await w.get()).json.entries.map((e: any) => e.seq)).toEqual([0, 1, 2, 3]);
});

test("the stored entry is exactly what was sent: seq, at, kind, text; gapSeconds null for a line; a gap keeps its seconds; text may be left out", async () => {
  const w = await world();
  await w.post([w.entry(0, { text: "● session sonnet" }), { seq: 5, at: "2026-10-29T10:00:05.000Z", kind: "gap", gapSeconds: 30 }, { seq: 6, at: "2026-10-29T10:00:36.000Z", kind: "truncated" }]);
  const r = await w.get();
  expect(r.status).toBe(200);
  expect(r.json).toEqual({
    hopId: w.hop.id, more: false, entries: [
      { seq: 0, at: "2026-10-29T10:00:00.000Z", kind: "line", text: "● session sonnet", gapSeconds: null },
      { seq: 5, at: "2026-10-29T10:00:05.000Z", kind: "gap", text: "", gapSeconds: 30 },
      { seq: 6, at: "2026-10-29T10:00:36.000Z", kind: "truncated", text: "", gapSeconds: null },
    ],
  });
});

test("only a runner posts: the operator and a worker → 403 runner_only (for a real hop and for an unknown one); nothing is stored", async () => {
  const w = await world();
  for (const actor of ["operator", `worker:${w.a.id}`]) {
    for (const id of [w.hop.id, NO_HOP]) {
      const r = await w.post([w.entry(0)], id, actor);
      expect([actor, r.status, r.json.error.code]).toEqual([actor, 403, "runner_only"]);
    }
  }
  expect((await w.post([w.entry(0)], w.hop.id, null)).status).toBe(400); // no actor at all
  expect((await w.get()).json.entries).toEqual([]);
});

test("a runner is still refused on the routes it may not use — and its allow-list now says it may send output", async () => {
  const w = await world();
  const r = await w.call("POST", "/v1/workers", { name: "x", roles: ["FE"], skills: ["s"] }, "runner:r1");
  expect([r.status, r.json.error.code]).toEqual([403, "runner_not_allowed"]);
  expect(r.json.error.message).toContain("hop's output");
});

test("an unknown hop → 404 not_found; a non-uuid id → 404; both for POST and GET", async () => {
  const w = await world();
  for (const id of [NO_HOP, "not-a-uuid"]) {
    expect([id, (await w.post([w.entry(0)], id)).status, (await w.post([w.entry(0)], id)).json.error.code]).toEqual([id, 404, "not_found"]);
    const g = await w.get("", id);
    expect([id, g.status, g.json.error.code]).toEqual([id, 404, "not_found"]);
  }
});

test("bad bodies → 400 validation: 201 entries, 0 entries, text of 2001 chars, a gap without gapSeconds, gapSeconds on a line, seq < 0, a kind that does not exist, at that is not a time", async () => {
  const w = await world();
  const many = Array.from({ length: 201 }, (_, i) => w.entry(i));
  const cases: [string, unknown][] = [
    ["201 entries", many],
    ["no entries", []],
    ["text 2001", [w.entry(0, { text: "x".repeat(2001) })]],
    ["gap without gapSeconds", [w.entry(0, { kind: "gap", text: "" })]],
    ["gap with gapSeconds null", [w.entry(0, { kind: "gap", text: "", gapSeconds: null })]],
    ["gap with 0 seconds", [w.entry(0, { kind: "gap", text: "", gapSeconds: 0 })]],
    ["line with gapSeconds", [w.entry(0, { gapSeconds: 5 })]],
    ["negative seq", [w.entry(-1)]],
    ["unknown kind", [w.entry(0, { kind: "banner" })]],
    ["at not a time", [w.entry(0, { at: "yesterday" })]],
  ];
  for (const [what, entries] of cases) {
    const r = await w.post(entries);
    expect([what, r.status, r.json.error.code]).toEqual([what, 400, "validation"]);
  }
  expect((await w.call("POST", `/v1/hops/${w.hop.id}/output`, { nope: 1 }, "runner:r1")).status).toBe(400);
  expect((await w.get()).json.entries).toEqual([]); // a refused batch stored nothing, not even its good entries
  // the limits themselves are fine: 200 entries, text of exactly 2000 chars
  expect((await w.post(many.slice(0, 200))).json).toEqual({ stored: 200 });
  expect((await w.post([w.entry(500, { text: "x".repeat(2000) })])).json).toEqual({ stored: 1 });
});

test("GET: ascending; `after` is exclusive; `limit` caps and `more` says there is further; defaults are after −1, limit 500; bad query → 400", async () => {
  const w = await world();
  await w.post([w.entry(9), w.entry(2), w.entry(7), w.entry(4), w.entry(0)]); // sent out of order, stored by seq
  const all = (await w.get()).json;
  expect([all.entries.map((e: any) => e.seq), all.more]).toEqual([[0, 2, 4, 7, 9], false]);
  const page1 = (await w.get("?limit=2")).json;
  expect([page1.entries.map((e: any) => e.seq), page1.more]).toEqual([[0, 2], true]);
  const page2 = (await w.get("?after=2&limit=2")).json;
  expect([page2.entries.map((e: any) => e.seq), page2.more]).toEqual([[4, 7], true]);
  const page3 = (await w.get("?after=7&limit=2")).json;
  expect([page3.entries.map((e: any) => e.seq), page3.more]).toEqual([[9], false]);
  const exact = (await w.get("?after=-1&limit=5")).json;
  expect([exact.entries.length, exact.more]).toEqual([5, false]); // exactly `limit` left: no more
  expect((await w.get("?after=9")).json).toEqual({ hopId: w.hop.id, entries: [], more: false });
  for (const q of ["?limit=0", "?limit=1001", "?limit=x", "?after=1.5"]) expect([q, (await w.get(q)).status]).toEqual([q, 400]);
});

test("GET needs no actor and answers any actor", async () => {
  const w = await world();
  await w.post([w.entry(0)]);
  for (const actor of [null, "operator", `worker:${w.a.id}`, "runner:r1"]) {
    const r = await w.get("", w.hop.id, actor);
    expect([actor, r.status, r.json.entries.length]).toEqual([actor, 200, 1]);
  }
});

test("rows are readable after the hop finished, and a last batch may still land after hop.finished", async () => {
  const w = await world();
  await w.post([w.entry(0), w.entry(1)]);
  expect((await w.call("PATCH", `/v1/hops/${w.hop.id}`, { outcome: "commented" })).status).toBe(200);
  expect((await w.get()).json.entries.map((e: any) => e.seq)).toEqual([0, 1]);
  expect((await w.post([w.entry(2)])).json).toEqual({ stored: 1 });
  expect((await w.get("?after=1")).json.entries.map((e: any) => e.seq)).toEqual([2]);
});

test("output is not an event: the events feed has no new type and rebuild-check is same:true", async () => {
  const w = await world();
  const before = (await w.call("GET", `${w.P}/events`)).json.events.length;
  await w.post([w.entry(0), w.entry(1)]);
  await w.call("PATCH", `/v1/hops/${w.hop.id}`, { outcome: "commented" });
  const events = (await w.call("GET", `${w.P}/events`)).json.events as any[];
  expect(events.length).toBe(before + 1); // only hop.finished
  expect(events.some((e) => /output/.test(e.type))).toBe(false);
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
});

test("the two routes are in the OpenAPI document", async () => {
  const w = await world();
  const doc = (await w.call("GET", "/v1/openapi.json")).json;
  expect(Object.keys(doc.paths["/v1/hops/{hopId}/output"]).sort()).toEqual(["get", "post"]);
  expect(doc.components.schemas.HopOutputEntry.required.sort()).toEqual(["at", "gapSeconds", "kind", "seq", "text"]);
});
