// TASK-A-081 / contract v1.8 (D-055): a chat hop (a hop with a messageId) is OUTSIDE the hop budget — exempt from a run's budget
// (the only budget, REQ-120), and not counted in Project.hopsUsed nor Run.hopsUsed. It keeps its times, tokens and outcome and
// is listed in GET …/hops (the cost stays visible). hop_running and the claim rules still apply to it. Card hops are unchanged.
import { expect, test } from "bun:test";
import { chatHop, chatWorld, newCard, postChat, setup, type Call } from "../helpers/api";

async function world() {
  const s = await setup();
  const chain = await chatWorld(s.call);
  const P = `/v1/projects/${chain.project.id}`;
  const cardHop = (cardId: string, extra: object = {}) => s.call("POST", `${P}/hops`, { cardId, workerId: chain.a.id, ...extra });
  const card = async (title = "งาน") => (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id, title })).json;
  const message = async (text = "ข้อความ") => (await postChat(s.call, chain.project.id, text)).json;
  const finish = (id: string, body: object = { outcome: "commented" }) => s.call("PATCH", `/v1/hops/${id}`, body);
  const getProject = async () => (await s.call("GET", P)).json;
  return { ...s, ...chain, P, cardHop, card, message, finish, getProject };
}
const used = async (call: Call, P: string) => (await call("GET", P)).json.hopsUsed as number;

test("a run at its budget: a CARD hop → 409 no_budget, a CHAT hop → 201 (REQ-120: the run's budget is the only one)", async () => {
  const w = await world();
  await w.call("PATCH", `${w.P}/mode`, { mode: "dispatcher", hopBudget: 1 });
  const run = (await w.call("POST", `${w.P}/runs`, { hopBudget: 1 })).json;
  const c1 = await w.card("ใบแรก"), c2 = await w.card("ใบสอง");
  const h = await w.cardHop(c1.id, { runId: run.id });
  expect(h.status).toBe(201);
  await w.finish(h.json.id);
  expect(await w.getProject()).toMatchObject({ hopsUsed: 1, hopBudget: 1 });
  const spent = await w.cardHop(c2.id, { runId: run.id });
  expect([spent.status, spent.json.error.code]).toEqual([409, "no_budget"]);
  const m = await w.message();
  const chat = await w.call("POST", `${w.P}/hops`, { workerId: w.a.id, messageId: m.id });
  expect(chat.status).toBe(201);
});

test("a chat hop finished with tokens: hopsUsed unchanged, tokens / outcome / endedAt on the hop, and it is listed by GET …/hops", async () => {
  const w = await world();
  const m = await w.message();
  const hop = await chatHop(w.call, w.project.id, m.id, w.a.id);
  const done = await w.finish(hop.id, { outcome: "replied", tokensIn: 1200, tokensOut: 340, note: "ตอบแล้ว" });
  expect(done.status).toBe(200);
  expect(done.json).toMatchObject({ messageId: m.id, cardId: null, outcome: "replied", tokensIn: 1200, tokensOut: 340, note: "ตอบแล้ว" });
  expect(done.json.endedAt).toBeString();
  expect(await used(w.call, w.P)).toBe(0);
  const listed = (await w.call("GET", `${w.P}/hops`)).json.hops;
  expect(listed.map((x: any) => [x.id, x.outcome, x.tokensIn])).toEqual([[hop.id, "replied", 1200]]);
  // a card hop right after counts as before
  const c = await w.card();
  await w.finish((await w.cardHop(c.id)).json.id);
  expect(await used(w.call, w.P)).toBe(1);
});

test("in a run at its budget: a chat hop → 201, a card hop → 409 no_budget; Run.hopsUsed leaves chat hops out", async () => {
  const w = await world();
  const run = (await w.call("POST", `${w.P}/runs`, { hopBudget: 1 })).json;
  const c1 = await w.card("ใบแรก"), c2 = await w.card("ใบสอง");
  await w.finish((await w.cardHop(c1.id, { runId: run.id })).json.id);
  expect((await w.cardHop(c2.id, { runId: run.id })).json.error.code).toBe("no_budget"); // the run's one hop is used
  const m = await w.message();
  const chat = await w.call("POST", `${w.P}/hops`, { workerId: w.a.id, messageId: m.id, runId: run.id });
  expect(chat.status).toBe(201);
  await w.finish(chat.json.id, { outcome: "replied" });
  const m2 = await w.message("อีกข้อความ");
  expect((await w.call("POST", `${w.P}/hops`, { workerId: w.a.id, messageId: m2.id, runId: run.id })).status).toBe(201); // still in: chat hops never fill the budget
  expect((await w.call("GET", `${w.P}/runs`)).json.runs[0]).toMatchObject({ hopBudget: 1, hopsUsed: 1 }); // the card hop only
});

test("a run with a chat hop running and one budget left: the card hop is refused hop_running (not no_budget) — and the other way round", async () => {
  const w = await world();
  const run = (await w.call("POST", `${w.P}/runs`, { hopBudget: 1 })).json;
  const c = await w.card();
  const m = await w.message();
  const chat = await chatHop(w.call, w.project.id, m.id, w.a.id, { runId: run.id });
  expect((await w.cardHop(c.id, { runId: run.id })).json.error.code).toBe("hop_running"); // the budget has room (a chat hop does not count): the running hop is what refuses
  await w.finish(chat.id, { outcome: "replied" });
  const card = await w.cardHop(c.id, { runId: run.id });
  expect(card.status).toBe(201);
  const m2 = await w.message("อีกข้อความ");
  const refused = await w.call("POST", `${w.P}/hops`, { workerId: w.a.id, messageId: m2.id });
  expect([refused.status, refused.json.error.code]).toEqual([409, "hop_running"]); // a chat hop while a card hop runs
});

test("a chat hop while another hop runs → 409 hop_running; the claim rule still holds for chat hops (same value 200, another 409)", async () => {
  const w = await world();
  const m = await w.message(), m2 = await w.message("สอง");
  const hop = await chatHop(w.call, w.project.id, m.id, w.a.id, { claim: "runner-1" });
  const second = await w.call("POST", `${w.P}/hops`, { workerId: w.a.id, messageId: m2.id });
  expect([second.status, second.json.error.code]).toEqual([409, "hop_running"]);
  expect((await w.call("PATCH", `/v1/hops/${hop.id}`, { claim: "runner-1" })).status).toBe(200);
  expect((await w.call("PATCH", `/v1/hops/${hop.id}`, { claim: "runner-2" })).json.error.code).toBe("already_claimed");
});

test("an interrupted chat hop does not count either; rebuild-check is same:true after the whole sequence (the reducer skips hopsUsed for chat hops)", async () => {
  const w = await world();
  await w.call("PATCH", `${w.P}/mode`, { mode: "dispatcher", hopBudget: 2 });
  const run = (await w.call("POST", `${w.P}/runs`, { hopBudget: 2 })).json;
  const m = await w.message();
  const hop = await chatHop(w.call, w.project.id, m.id, w.a.id, { claim: "runner-gone", runId: run.id });
  await w.finish(hop.id, { outcome: "interrupted", note: "runner restarted" });
  const c = await w.card();
  await w.finish((await w.cardHop(c.id, { runId: run.id })).json.id);
  const m2 = await w.message("ข้อความที่สอง");
  await w.finish((await chatHop(w.call, w.project.id, m2.id, w.a.id, { runId: run.id })).id, { outcome: "proposed", tokensIn: 10, tokensOut: 5 });
  expect(await w.getProject()).toMatchObject({ hopsUsed: 1, hopBudget: 2 }); // the one card hop
  expect((await w.call("GET", `${w.P}/runs`)).json.runs[0]).toMatchObject({ hopsUsed: 1 });
  expect((await w.call("GET", `${w.P}/hops`)).json.hops).toHaveLength(3); // all three are listed: the cost stays visible
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
});
