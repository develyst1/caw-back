// REQ-125 (SPEC-124 D1–D3, TASK-166): a worker moves a card to review only with `done` + `howToTry` (CAW writes them as ONE note, in the same write), and a card made for a BE goes to a worker who
// is FE and not BE (or the other way round) only with a `reason`. Through the HTTP API on pglite:memory.
import { expect, test } from "bun:test";
import { events } from "../../src/db/schema";
import { createProject, hopHeader, newCard, openHop, setup } from "../helpers/api";

const as = (w: { id: string }) => `worker:${w.id}`;

async function world() {
  const s = await setup();
  const project = (await createProject(s.call)).json;
  const P = `/v1/projects/${project.id}`;
  const mk = async (name: string, roles: string[]) => {
    const w = (await s.call("POST", "/v1/workers", { name, roles, skills: ["s"] })).json;
    await s.call("POST", `${P}/chain/members`, { workerId: w.id });
    return w as { id: string; name: string; roles: string[] };
  };
  const be = await mk("Ann", ["BE"]), fe = await mk("Ben", ["FE"]), qa = await mk("Cat", ["QA"]), sa = await mk("Sid", ["SA"]), dual = await mk("Dee", ["BE", "FE"]);
  const edge = (from: { id: string }, to: { id: string }) => s.call("POST", `${P}/chain/edges`, { from: from.id, to: to.id });
  for (const [f, t] of [[be, fe], [be, qa], [qa, be], [sa, be], [sa, fe], [be, dual]] as const) await edge(f, t);
  const card = async (w: { id: string }) => (await newCard(s.call, project.id, { assigneeId: w.id })).json;
  /** a running hop of `w` on the card: what a worker's write must name */
  const hopOf = async (cardId: string, w: { id: string }) => hopHeader((await openHop(s.call, project.id, cardId, w.id)).id);
  const notes = async (cardId: string) => (await s.call("GET", `/v1/cards/${cardId}/context`)).json.notes as { type: string; actor: string; text: string }[];
  const eventCount = async () => (await s.db.select().from(events)).length;
  const finishHop = async (h: Record<string, string>) => s.call("PATCH", `/v1/hops/${h["x-caw-hop"]}`, { outcome: "handed_off" });
  return { ...s, project, be, fe, qa, sa, dual, card, hopOf, notes, eventCount, finishHop };
}
const STATUS = (id: string) => `/v1/cards/${id}/status`;
const HAND = (id: string) => `/v1/cards/${id}/handoff`;

test("(a) a worker's `review` with no fields → 409 review_note_missing naming both; the card is unchanged and nothing was written", async () => {
  const w = await world();
  const c = await w.card(w.be);
  const H = await w.hopOf(c.id, w.be);
  const before = await w.eventCount();
  const status0 = (await w.call("GET", `/v1/cards/${c.id}`)).json.status; // opening the hop already moved it
  const r = await w.call("PATCH", STATUS(c.id), { status: "review" }, as(w.be), H);
  expect([r.status, r.json.error.code, r.json.error.details]).toEqual([409, "review_note_missing", { missing: ["done", "howToTry"] }]);
  expect((await w.call("GET", `/v1/cards/${c.id}`)).json.status).toBe(status0);
  expect(await w.notes(c.id)).toEqual([]);
  expect(await w.eventCount()).toBe(before);
});

test("(b) only `done` → missing: [howToTry]; only `howToTry` → missing: [done]; blank text counts as missing", async () => {
  const w = await world();
  const c = await w.card(w.be);
  const H = await w.hopOf(c.id, w.be);
  const status0 = (await w.call("GET", `/v1/cards/${c.id}`)).json.status;
  const one = await w.call("PATCH", STATUS(c.id), { status: "review", done: "ทำหน้าอนุมัติแล้ว" }, as(w.be), H);
  expect([one.status, one.json.error.details]).toEqual([409, { missing: ["howToTry"] }]);
  const other = await w.call("PATCH", STATUS(c.id), { status: "review", howToTry: "เปิดหน้า /approve" }, as(w.be), H);
  expect(other.json.error.details).toEqual({ missing: ["done"] });
  const blank = await w.call("PATCH", STATUS(c.id), { status: "review", done: "  ", howToTry: "\n" }, as(w.be), H);
  expect(blank.json.error.details).toEqual({ missing: ["done", "howToTry"] });
  expect((await w.call("GET", `/v1/cards/${c.id}`)).json.status).toBe(status0);
});

test("(c) both → 200, status review, and the card's notes end with ONE comment `ทำแล้ว: …\\nลองได้โดย: …` by that worker, written before the status in the same write", async () => {
  const w = await world();
  const c = await w.card(w.be);
  const H = await w.hopOf(c.id, w.be);
  const r = await w.call("PATCH", STATUS(c.id), { status: "review", done: "  ทำหน้าอนุมัติแล้ว  ", howToTry: "เปิดหน้า /approve" }, as(w.be), H);
  expect([r.status, r.json.status]).toEqual([200, "review"]);
  const notes = await w.notes(c.id);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ type: "comment", actor: as(w.be), text: "ทำแล้ว: ทำหน้าอนุมัติแล้ว\nลองได้โดย: เปิดหน้า /approve" });
  const tail = (await w.db.select().from(events)).map((e) => e.type).slice(-2);
  expect(tail).toEqual(["card.commented", "card.status_set"]);
  expect((await w.call("POST", `/v1/projects/${w.project.id}/rebuild-check`)).json).toEqual({ same: true });
});

test("(d) the operator's `review` with no fields → 200 and no note; a worker's other statuses need no note", async () => {
  const w = await world();
  const c = await w.card(w.be);
  const op = await w.call("PATCH", STATUS(c.id), { status: "review" });
  expect([op.status, op.json.status]).toEqual([200, "review"]);
  expect(await w.notes(c.id)).toEqual([]);
  const c2 = await w.card(w.be);
  const H = await w.hopOf(c2.id, w.be);
  expect((await w.call("PATCH", STATUS(c2.id), { status: "doing" }, as(w.be), H)).status).toBe(200);
  expect(await w.notes(c2.id)).toEqual([]);
});

test("(e) a BE-made card handed by the BE to an FE-only worker with no reason → 409 wrong_role (cardRole BE); the card is still the BE's, nothing recorded", async () => {
  const w = await world();
  const c = await w.card(w.be);
  const H = await w.hopOf(c.id, w.be);
  const before = await w.eventCount();
  const r = await w.call("POST", HAND(c.id), { toWorkerId: w.fe.id, text: "ทำหน้าจอต่อ" }, as(w.be), H);
  expect([r.status, r.json.error.code]).toEqual([409, "wrong_role"]);
  expect(r.json.error.details).toEqual({ cardRole: "BE", toRoles: ["FE"] });
  expect((await w.call("GET", `/v1/cards/${c.id}`)).json.assigneeId).toBe(w.be.id);
  expect(await w.eventCount()).toBe(before);
});

test("(f) the same with a `reason` → 200, and the hand-off note = the text + a blank line + the reason", async () => {
  const w = await world();
  const c = await w.card(w.be);
  const H = await w.hopOf(c.id, w.be);
  const r = await w.call("POST", HAND(c.id), { toWorkerId: w.fe.id, text: "ทำหน้าจอต่อ", reason: "ต้องมีหน้าจอให้ผู้ใช้กด" }, as(w.be), H);
  expect([r.status, r.json.assigneeId]).toEqual([200, w.fe.id]);
  expect((await w.notes(c.id)).at(-1)).toMatchObject({ type: "handoff", text: "ทำหน้าจอต่อ\n\nต้องมีหน้าจอให้ผู้ใช้กด" });
  // a blank reason is no reason
  await w.finishHop(H);
  const c2 = await w.card(w.be);
  const H2 = await w.hopOf(c2.id, w.be);
  expect((await w.call("POST", HAND(c2.id), { toWorkerId: w.fe.id, text: "x", reason: "   " }, as(w.be), H2)).json.error.code).toBe("wrong_role");
});

test("(g) the BE hands the same kind of card to a QA worker with no reason → 200 (only the other builder role needs one)", async () => {
  const w = await world();
  const c = await w.card(w.be);
  const H = await w.hopOf(c.id, w.be);
  const r = await w.call("POST", HAND(c.id), { toWorkerId: w.qa.id, text: "ตรวจให้หน่อย" }, as(w.be), H);
  expect([r.status, r.json.assigneeId]).toEqual([200, w.qa.id]);
});

test("(h) a card made for an SA (no builder role) → any hand-off along the chain works, FE-only included, with no reason", async () => {
  const w = await world();
  const c = await w.card(w.sa);
  const H = await w.hopOf(c.id, w.sa);
  const r = await w.call("POST", HAND(c.id), { toWorkerId: w.fe.id, text: "ออกแบบแล้ว ทำต่อ" }, as(w.sa), H);
  expect([r.status, r.json.assigneeId]).toEqual([200, w.fe.id]);
});

test("(i) the D1 boundary: a card made for the BE, handed BE → QA → BE → FE-only, is still `wrong_role` (made for = the first hand-off's sender)", async () => {
  const w = await world();
  const c = await w.card(w.be);
  const h1 = await w.hopOf(c.id, w.be);
  expect((await w.call("POST", HAND(c.id), { toWorkerId: w.qa.id, text: "ตรวจ" }, as(w.be), h1)).status).toBe(200);
  await w.finishHop(h1);
  const h2 = await w.hopOf(c.id, w.qa);
  expect((await w.call("POST", HAND(c.id), { toWorkerId: w.be.id, text: "กลับไปแก้" }, as(w.qa), h2)).status).toBe(200);
  await w.finishHop(h2);
  const h3 = await w.hopOf(c.id, w.be);
  const r = await w.call("POST", HAND(c.id), { toWorkerId: w.fe.id, text: "ทำหน้าจอ" }, as(w.be), h3);
  expect([r.status, r.json.error.code, r.json.error.details.cardRole]).toEqual([409, "wrong_role", "BE"]);
});

test("(j) a worker with BE + FE receiving a BE card → 200 with no reason (it is a BE too)", async () => {
  const w = await world();
  const c = await w.card(w.be);
  const H = await w.hopOf(c.id, w.be);
  const r = await w.call("POST", HAND(c.id), { toWorkerId: w.dual.id, text: "ทำต่อ" }, as(w.be), H);
  expect([r.status, r.json.assigneeId]).toEqual([200, w.dual.id]);
});

test("(k) the refusals are not recorded as a refused hand-off (only chain_broken is), and `reason` is optional elsewhere: an off-chain refusal still wins and is recorded", async () => {
  const w = await world();
  const c = await w.card(w.be);
  const H = await w.hopOf(c.id, w.be);
  await w.call("POST", HAND(c.id), { toWorkerId: w.fe.id, text: "x" }, as(w.be), H); // wrong_role
  expect((await w.notes(c.id)).map((n) => n.type)).toEqual([]);
  const off = await w.call("POST", HAND(c.id), { toWorkerId: w.sa.id, text: "ข้ามสาย", reason: "x" }, as(w.be), H); // no edge be → sa
  expect(off.json.error.code).toBe("chain_broken");
  expect((await w.notes(c.id)).map((n) => n.type)).toEqual(["handoff_refused"]);
});
