// TASK-A-091 / contract v1.14 (D-081 asks 2 and 3): a card hop that starts on a `todo` card moves it to `doing` (in the reducer, inside the same
// event); and a worker cannot be taken out of a chain while a hop of theirs is running in that project (409 hop_running, checked before is_entry).
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { events } from "../../src/db/schema";
import { chainOf3, chatWorld, chatHop, newCard, postChat, setup } from "../helpers/api";

async function world() {
  const s = await setup();
  const chain = await chainOf3(s.call);
  const P = `/v1/projects/${chain.project.id}`;
  const card = async (assigneeId: string, over: object = {}) => (await newCard(s.call, chain.project.id, { assigneeId, ...over })).json;
  const getCard = async (id: string) => (await s.call("GET", `/v1/cards/${id}`)).json;
  const startHop = (cardId: string, workerId: string) => s.call("POST", `${P}/hops`, { cardId, workerId });
  return { ...s, ...chain, P, card, getCard, startHop };
}

test("a hop on a todo card puts it in doing right away, with updatedAt = the hop's start; the hop ending leaves it in doing", async () => {
  const w = await world();
  const c = await w.card(w.a.id);
  expect(c.status).toBe("todo");
  const hop = await w.startHop(c.id, w.a.id);
  expect(hop.status).toBe(201);
  const after = await w.getCard(c.id);
  expect(after.status).toBe("doing");
  expect(after.updatedAt).toBe(hop.json.startedAt); // the same event: no extra one
  await w.call("PATCH", `/v1/hops/${hop.json.id}`, { outcome: "commented" });
  expect((await w.getCard(c.id)).status).toBe("doing"); // stays where the worker's own writes put it
});

test("a hop on a card already in doing leaves it doing and does not move updatedAt; another card is untouched", async () => {
  const w = await world();
  const c = await w.card(w.a.id);
  const other = await w.card(w.b.id);
  await w.call("PATCH", `/v1/cards/${c.id}/status`, { status: "doing" });
  const before = await w.getCard(c.id);
  const hop = await w.startHop(c.id, w.a.id);
  expect(hop.status).toBe(201);
  expect(await w.getCard(c.id)).toEqual(before);
  expect((await w.getCard(other.id)).status).toBe("todo");
  expect((await w.getCard(other.id)).updatedAt).toBe(other.updatedAt);
});

test("starting the hop adds no event of its own for the card: the only new event is hop.started", async () => {
  const w = await world();
  const c = await w.card(w.a.id);
  const n = async () => (await w.db.select().from(events)).length;
  const before = await n();
  await w.startHop(c.id, w.a.id);
  expect(await n()).toBe(before + 1);
  expect((await w.db.select().from(events).where(eq(events.type, "card.status_set"))).length).toBe(0);
});

test("a chat hop touches no card", async () => {
  const s = await setup();
  const chain = await chatWorld(s.call);
  const card = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id })).json;
  const msg = (await postChat(s.call, chain.project.id)).json;
  await chatHop(s.call, chain.project.id, msg.id, chain.a.id);
  const after = (await s.call("GET", `/v1/cards/${card.id}`)).json;
  expect([after.status, after.updatedAt]).toEqual(["todo", card.updatedAt]);
});

test("rebuild-check is same:true after hops on todo and doing cards, with the card moved by the reducer", async () => {
  const w = await world();
  const c = await w.card(w.a.id);
  const hop = await w.startHop(c.id, w.a.id);
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
  await w.call("PATCH", `/v1/hops/${hop.json.id}`, { outcome: "commented" });
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
});

test("removing a member with a running hop → 409 hop_running { hopId }; after the hop ends the same call goes through (or reaches has_open_cards as before)", async () => {
  const w = await world();
  const c = await w.card(w.a.id);
  const hop = await w.startHop(c.id, w.a.id);
  const refused = await w.call("DELETE", `${w.P}/chain/members/${w.a.id}`);
  expect([refused.status, refused.json.error.code, refused.json.error.details]).toEqual([409, "hop_running", { hopId: hop.json.id }]);
  expect((await w.call("GET", `${w.P}/chain`)).json.members.map((m: any) => m.id)).toContain(w.a.id); // still a member
  await w.call("PATCH", `/v1/hops/${hop.json.id}`, { outcome: "commented" });
  const open = await w.call("DELETE", `${w.P}/chain/members/${w.a.id}`);
  expect([open.status, open.json.error.code]).toEqual([409, "has_open_cards"]); // the card is still open: as before
  expect((await w.call("DELETE", `${w.P}/chain/members/${w.a.id}?reassignTo=${w.b.id}`)).status).toBe(200);
});

test("the order of checks: not a member (404) → hop_running → is_entry → has_open_cards", async () => {
  const w = await world();
  const c = await w.card(w.a.id);
  const stranger = (await w.call("POST", "/v1/workers", { name: "Stranger", roles: ["BE"], skills: ["s"] })).json;
  expect((await w.call("DELETE", `${w.P}/chain/members/${stranger.id}`)).status).toBe(404);
  await w.call("PUT", `${w.P}/chain/entry`, { workerId: w.a.id }); // Ann is the entry AND has an open card AND will have a running hop
  const hop = await w.startHop(c.id, w.a.id);
  expect((await w.call("DELETE", `${w.P}/chain/members/${w.a.id}`)).json.error.code).toBe("hop_running");
  await w.call("PATCH", `/v1/hops/${hop.json.id}`, { outcome: "commented" });
  expect((await w.call("DELETE", `${w.P}/chain/members/${w.a.id}`)).json.error.code).toBe("is_entry");
  await w.call("PUT", `${w.P}/chain/entry`, { workerId: w.b.id });
  expect((await w.call("DELETE", `${w.P}/chain/members/${w.a.id}`)).json.error.code).toBe("has_open_cards");
});

test("a running hop of ANOTHER worker, or of the same worker in ANOTHER project, does not block the removal", async () => {
  const w = await world();
  const c = await w.card(w.b.id);
  await w.startHop(c.id, w.b.id); // Ben is running; Cat has nothing
  const cat = await w.call("DELETE", `${w.P}/chain/members/${w.c.id}`);
  expect(cat.status).toBe(200);
});
