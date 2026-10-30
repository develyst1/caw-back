// TASK-A-079 / contract v1.4 (REQ-013): the seam proxy — locate and amendments — over the RECORDED answers of a real blueprint-back.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { chatHop, chatWorld, hopHeader, postChat, setup } from "../helpers/api";
import { BP_PROJECT } from "../helpers/fake-blueprint";

const fix = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/blueprint/${name}.json`, import.meta.url), "utf8"));

async function world() {
  const s = await setup();
  const chain = await chatWorld(s.call);
  const P = `/v1/projects/${chain.project.id}`;
  const msg = (await postChat(s.call, chain.project.id)).json;
  const hop = await chatHop(s.call, chain.project.id, msg.id, chain.a.id);
  return { ...s, ...chain, P, msg, hop, as: `worker:${chain.a.id}`, H: hopHeader(hop.id) };
}

// was: Located AS RETURNED from POST …/locate (with `version`). REQ-105 (D1): the call goes to …/spec/locate and the answer carries `revision` instead of `version`
// (synthetic v2: the recorded Located with version → revision).
const v2Located = (name: string) => { const { version: _v, ...rest } = fix(name); return { ...rest, revision: 1 }; };
test("locate: Blueprint's v2 Located AS RETURNED (200, via /spec/locate); the hop keeps only the keys; the operator may call it too (no hop, no keys)", async () => {
  const w = await world();
  const r = await w.call("POST", `${w.P}/locate`, { request: "ห้องใหญ่ต้องอนุมัติ" }, w.as, w.H);
  expect(r.status).toBe(200);
  expect(r.json).toEqual(v2Located("locate-room"));
  expect(w.fake.mode.bodies.at(-1)).toEqual({ path: `/v1/projects/${BP_PROJECT}/spec/locate`, body: { request: "ห้องใหญ่ต้องอนุมัติ" } });
  expect((await w.call("GET", `${w.P}/hops?limit=1`)).json.hops[0].locatedKeys).toEqual(fix("locate-room").candidates.map((c: any) => c.key));
  const op = await w.call("POST", `${w.P}/locate`, { request: "ค้นหาห้องว่าง" }); // the operator: no hop, nothing recorded
  expect(op.json).toEqual(v2Located("locate-search"));
  expect((await w.call("GET", `${w.P}/hops?limit=1`)).json.hops[0].locatedKeys).toHaveLength(4);
  expect((await w.call("POST", `${w.P}/locate`, { request: "xyzzy plugh" }, w.as, w.H)).json).toEqual(v2Located("locate-none"));
});

test("locate: request 1–1 000 characters (400) · a worker needs its running chat hop (400 / 403) · a runner is refused · 404 · Blueprint down → 502", async () => {
  const w = await world();
  const L = `${w.P}/locate`;
  expect((await w.call("POST", L, { request: "" }, w.as, w.H)).status).toBe(400);
  expect((await w.call("POST", L, { request: "x".repeat(1001) }, w.as, w.H)).status).toBe(400);
  expect((await w.call("POST", L, { request: "ห้อง" }, w.as)).json.error.code).toBe("hop_required");
  expect((await w.call("POST", L, { request: "ห้อง" }, `worker:${w.b.id}`, w.H)).json.error.code).toBe("not_your_message");
  expect((await w.call("POST", L, { request: "ห้อง" }, "runner:r-1")).json.error.code).toBe("runner_not_allowed");
  expect((await w.call("POST", "/v1/projects/00000000-0000-0000-0000-000000000099/locate", { request: "ห้อง" })).status).toBe(404);
  await w.call("PATCH", `/v1/hops/${w.hop.id}`, { outcome: "replied" });
  expect((await w.call("POST", L, { request: "ห้อง" }, w.as, w.H)).json.error.code).toBe("not_your_message"); // the hop ended
  w.fake.mode.down = true;
  const down = await w.call("POST", L, { request: "ห้อง" }); // the operator, so the guard is not what answers
  expect([down.status, down.json.error.code]).toEqual([502, "blueprint_unreachable"]);
});

test("amendments: Blueprint's Message AS RETURNED (201); `from` is filled by the core as caw:<projectId>:<hopId>; `about` passed on", async () => {
  const w = await world();
  const r = await w.call("POST", `${w.P}/amendments`, { request: "ขอเพิ่มเรื่องห้องประชุมกลางแจ้ง", about: ["STEP-004"] }, w.as, w.H);
  expect(r.status).toBe(201);
  expect(r.json).toEqual(fix("amendment-201"));
  expect(w.fake.mode.bodies.at(-1)).toEqual({
    path: `/v1/projects/${BP_PROJECT}/amendments`,
    body: { from: `caw:${w.project.id}:${w.hop.id}`, request: "ขอเพิ่มเรื่องห้องประชุมกลางแจ้ง", about: ["STEP-004"] },
  });
  expect(w.fake.mode.bodies.at(-1)!.body.from.length).toBeLessThanOrEqual(100); // Blueprint's limit
  const op = await w.call("POST", `${w.P}/amendments`, { request: "จากเจ้าของ" });
  expect(op.status).toBe(201);
  expect(w.fake.mode.bodies.at(-1)!.body).toEqual({ from: `caw:${w.project.id}:operator`, request: "จากเจ้าของ" }); // no `about` key when none given
});

test("amendments: request 1–4 000 · about ≤ 20 · Blueprint's 400 (an unknown key) comes back as 400 amendment_refused with its words · worker guard · 502", async () => {
  const w = await world();
  const A = `${w.P}/amendments`;
  expect((await w.call("POST", A, { request: "" }, w.as, w.H)).status).toBe(400);
  expect((await w.call("POST", A, { request: "x".repeat(4001) }, w.as, w.H)).status).toBe(400);
  expect((await w.call("POST", A, { request: "x", about: Array.from({ length: 21 }, (_, i) => `K-${i}`) }, w.as, w.H)).status).toBe(400);
  const refused = await w.call("POST", A, { request: "ขอ", about: ["NOPE-999"] }, w.as, w.H);
  expect([refused.status, refused.json.error.code, refused.json.error.message]).toEqual([400, "amendment_refused", fix("amendment-400-about").error.message]);
  expect((await w.call("POST", A, { request: "ขอ" }, w.as)).json.error.code).toBe("hop_required");
  expect((await w.call("POST", A, { request: "ขอ" }, `worker:${w.b.id}`, w.H)).json.error.code).toBe("not_your_message");
  expect((await w.call("POST", A, { request: "ขอ" }, "runner:r-1")).json.error.code).toBe("runner_not_allowed");
  w.fake.mode.down = true;
  expect((await w.call("POST", A, { request: "ขอ" }, w.as, w.H)).json.error.code).toBe("blueprint_unreachable");
});

// was: no column of ANY caw table holds part text. REQ-105 (SPEC-107 D3, owner-visible change in the spec): the two operational tables spec_parts / hop_spec DO hold the body CAW last read —
// that is their whole job — so they are the named exceptions; every other table and every event stays free of part text.
test("no spec text is stored outside spec_parts / hop_spec: after a locate, a proposal and an accepted card, no other column of any caw table holds a Blueprint part's text — only keys", async () => {
  const w = await world();
  const found = fix("locate-room").candidates as { key: string; title: string }[];
  await w.call("POST", `${w.P}/locate`, { request: "ห้องใหญ่ต้องอนุมัติ" }, w.as, w.H);
  const p = (await w.call("POST", `${w.P}/proposals`, { messageId: w.msg.id, items: [{ title: "งานของฉัน", todo: "ทำ", anchor: { key: "STEP-004", version: 1 }, workerId: w.b.id, dependsOn: [], hops: 1 }] }, w.as, w.H)).json;
  await w.call("POST", `/v1/proposals/${p.id}/accept`);
  const version = fix("version-1-200");
  const texts: string[] = [...new Set(version.parts.flatMap((x: any) => [x.title, x.body?.text, x.body?.rule, x.body?.note].filter((t: unknown): t is string => typeof t === "string" && t.length > 2)))] as string[];
  expect(texts.length).toBeGreaterThan(20);
  expect(found.length).toBeGreaterThan(0);
  const rowsOf = async <T>(q: ReturnType<typeof sql>) => ((await w.db.execute(q)) as unknown as { rows: T[] }).rows;
  const cols = await rowsOf<{ table_name: string; column_name: string }>(sql`select table_name, column_name from information_schema.columns where table_schema = 'caw' order by 1, 2`);
  expect(cols.length).toBeGreaterThan(90);
  const hits: string[] = [];
  for (const { table_name, column_name } of cols) {
    const rows = await rowsOf<{ v: string | null }>(sql.raw(`select "${column_name}"::text as v from caw."${table_name}"`));
    for (const { v } of rows) for (const t of texts) if (v?.includes(t) && !(table_name === "projects" && column_name === "name") && !(table_name === "events" && column_name === "data") && !(["spec_parts", "hop_spec"].includes(table_name) && column_name === "body")) hits.push(`${table_name}.${column_name} ⊃ ${t}`);
  }
  expect(hits).toEqual([]);
  // the events: the located part titles are not in any event's data either (the project name — the one allowed exception — is not a located part here)
  const evs = (await w.db.execute(sql`select data::text as d from caw.events where type in ('hop.located','proposal.made','proposal.accepted')`) as unknown as { rows: { d: string }[] }).rows;
  for (const { d } of evs) for (const c of found) expect([c.key, d.includes(c.title)]).toEqual([c.key, false]);
  void eq;
});
