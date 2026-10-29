// TASK-119 / SPEC-108 D6 + D7 (REQ-111): a finished hop sends its card back from `doing` to `todo` (a plain card.status_set in the same write), and the card says why:
// `stoppedMidway` = { hopId, at, reason } when the card is `todo`, nothing runs on it and its latest ended hop was failed / stopped / interrupted; else null.
import { eq } from "drizzle-orm";
import { expect, test } from "bun:test";
import { events } from "../../src/db/schema";
import { chainOf3, chatWorld, chatHop, newCard, postChat, setup } from "../helpers/api";

async function world() {
  const s = await setup();
  const chain = await chainOf3(s.call);
  const P = `/v1/projects/${chain.project.id}`;
  const card = async (over: object = {}) => (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id, ...over })).json;
  const getCard = async (id: string) => (await s.call("GET", `/v1/cards/${id}`)).json;
  const startHop = async (cardId: string) => (await s.call("POST", `${P}/hops`, { cardId, workerId: chain.a.id })).json as { id: string; startedAt: string };
  const finish = (hopId: string, body: object, actor = "runner:r1") => s.call("PATCH", `/v1/hops/${hopId}`, body, actor);
  const statusEvents = async () => (await s.db.select().from(events).where(eq(events.type, "card.status_set"))).map((e) => [e.actor, e.data]);
  return { ...s, ...chain, P, card, getCard, startHop, finish, statusEvents };
}
const NOTE = "หยุดไว้: Blew พยายาม git push ซึ่งไม่อนุญาต";

test("a hop finished `stopped` → the card is todo again and says why: stoppedMidway { hopId, at = the hop's endedAt, reason = the note's first segment }", async () => {
  const w = await world();
  const c = await w.card();
  const hop = await w.startHop(c.id);
  expect((await w.getCard(c.id)).status).toBe("doing");
  const done = await w.finish(hop.id, { outcome: "stopped", note: `${NOTE} · อ่านนอกโฟลเดอร์ถูกปฏิเสธ 2 ครั้ง · tools: Bash×1` });
  expect(done.status).toBe(200);
  const after = await w.getCard(c.id);
  expect(after.status).toBe("todo");
  expect(after.stoppedMidway).toEqual({ hopId: hop.id, at: done.json.endedAt, reason: NOTE });
  expect(after.workable).toBe(true); // the next run picks it up like any todo card
  // the same in the list
  const listed = ((await w.call("GET", `${w.P}/cards`)).json.cards as any[]).find((x) => x.id === c.id);
  expect(listed.stoppedMidway).toEqual(after.stoppedMidway);
});

test("`failed` and a note with no ' · ' → reason is the whole note; an empty note → reason is the empty string", async () => {
  const w = await world();
  const c = await w.card();
  const h1 = await w.startHop(c.id);
  await w.finish(h1.id, { outcome: "failed", note: "ก้าวนี้ไม่ได้ทิ้งผลงานไว้" });
  expect((await w.getCard(c.id)).stoppedMidway).toMatchObject({ hopId: h1.id, reason: "ก้าวนี้ไม่ได้ทิ้งผลงานไว้" });
  const h2 = await w.startHop(c.id);
  await w.finish(h2.id, { outcome: "failed" });
  expect((await w.getCard(c.id)).stoppedMidway).toMatchObject({ hopId: h2.id, reason: "" }); // the LATEST hop decides
});

test("a hop finished `commented` (or any outcome the worker did not follow with a move) → todo, stoppedMidway null", async () => {
  const w = await world();
  const c = await w.card();
  const hop = await w.startHop(c.id);
  await w.finish(hop.id, { outcome: "commented" });
  const after = await w.getCard(c.id);
  expect([after.status, after.stoppedMidway]).toEqual(["todo", null]);
});

test("the runner's `interrupted` finish → todo + stoppedMidway (the restart rule ends an orphan this way)", async () => {
  const w = await world();
  const c = await w.card();
  const hop = await w.startHop(c.id);
  await w.finish(hop.id, { outcome: "interrupted", note: "ถูกขัดจังหวะเพราะตัวรันเริ่มใหม่" });
  const after = await w.getCard(c.id);
  expect([after.status, after.stoppedMidway?.reason]).toEqual(["todo", "ถูกขัดจังหวะเพราะตัวรันเริ่มใหม่"]);
});

test("a later hop starts → the card is doing and stoppedMidway is null; when it ends `commented` the latest hop is the good one → null; when it ends `stopped` → about THAT hop", async () => {
  const w = await world();
  const c = await w.card();
  const h1 = await w.startHop(c.id);
  await w.finish(h1.id, { outcome: "stopped", note: NOTE });
  expect((await w.getCard(c.id)).stoppedMidway?.hopId).toBe(h1.id);
  const h2 = await w.startHop(c.id);
  const running = await w.getCard(c.id);
  expect([running.status, running.stoppedMidway]).toEqual(["doing", null]);
  await w.finish(h2.id, { outcome: "commented" });
  expect((await w.getCard(c.id)).stoppedMidway).toBeNull(); // h2 (commented) is the latest ended hop
  const h3 = await w.startHop(c.id);
  await w.finish(h3.id, { outcome: "stopped", note: "หมดเวลา — ก้าวนี้ใช้เวลานานเกินไป" });
  expect((await w.getCard(c.id)).stoppedMidway).toMatchObject({ hopId: h3.id, reason: "หมดเวลา — ก้าวนี้ใช้เวลานานเกินไป" });
});

test("a card the worker moved during the hop (review / done / stuck) stays where it put it, and has no stoppedMidway", async () => {
  const w = await world();
  for (const status of ["review", "done", "stuck"]) {
    const c = await w.card();
    const hop = await w.startHop(c.id);
    expect((await w.call("PATCH", `/v1/cards/${c.id}/status`, { status })).status).toBe(200);
    await w.finish(hop.id, { outcome: "stopped", note: NOTE });
    const after = await w.getCard(c.id);
    expect([status, after.status, after.stoppedMidway]).toEqual([status, status, null]);
  }
});

test("a chat hop writes no card event and touches no card", async () => {
  const s = await setup();
  const chain = await chatWorld(s.call);
  const card = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id })).json;
  const msg = (await postChat(s.call, chain.project.id)).json;
  const hop = await chatHop(s.call, chain.project.id, msg.id, chain.a.id);
  await s.call("PATCH", `/v1/hops/${hop.id}`, { outcome: "failed", note: "x" }, "runner:r1");
  const after = (await s.call("GET", `/v1/cards/${card.id}`)).json;
  expect([after.status, after.updatedAt, after.stoppedMidway]).toEqual(["todo", card.updatedAt, null]);
  expect((await s.db.select().from(events).where(eq(events.type, "card.status_set"))).length).toBe(0);
});

test("exactly one extra event, by the actor that finished the hop; a card already `todo` or moved by the worker gets none; rebuild-check stays same:true", async () => {
  const w = await world();
  const c = await w.card();
  const hop = await w.startHop(c.id);
  const before = (await w.db.select().from(events)).length;
  await w.finish(hop.id, { outcome: "stopped", note: NOTE }, "runner:r9");
  expect((await w.db.select().from(events)).length).toBe(before + 2); // hop.finished + card.status_set
  expect(await w.statusEvents()).toEqual([["runner:r9", { cardId: c.id, status: "todo" }]]);
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
  // a second card, moved to review by the worker: no extra event
  const d = await w.card();
  const h2 = await w.startHop(d.id);
  await w.call("PATCH", `/v1/cards/${d.id}/status`, { status: "review" });
  const n2 = (await w.db.select().from(events)).length;
  await w.finish(h2.id, { outcome: "commented" });
  expect((await w.db.select().from(events)).length).toBe(n2 + 1); // only hop.finished
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
});

test("finishing a hop twice is still refused (409 already_finished) and the card is not moved a second time", async () => {
  const w = await world();
  const c = await w.card();
  const hop = await w.startHop(c.id);
  await w.finish(hop.id, { outcome: "stopped", note: NOTE });
  const again = await w.finish(hop.id, { outcome: "commented" });
  expect([again.status, again.json.error.code]).toEqual([409, "already_finished"]);
  expect((await w.statusEvents()).length).toBe(1);
});

test("the card in a card_context answer carries stoppedMidway too (the same Card shape)", async () => {
  const w = await world();
  const c = await w.card();
  const hop = await w.startHop(c.id);
  await w.finish(hop.id, { outcome: "failed", note: "ก้าวนี้ไม่ได้ทิ้งผลงานไว้" });
  const ctx = (await w.call("GET", `/v1/cards/${c.id}/context`)).json;
  expect(ctx.card.stoppedMidway).toMatchObject({ hopId: hop.id });
});
