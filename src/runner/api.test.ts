// The runner's API client, against the real app on PGlite (the same helpers Team A's suites use; imported, not edited).
import { describe, expect, test } from "bun:test";
import { chainOf3, newCard, setup } from "../../test/helpers/api";
import { RunnerApiError, createApi } from "./api";

async function world() {
  const t = await setup();
  const { project, a } = await chainOf3(t.call);
  const card = (await newCard(t.call, project.id, { assigneeId: a.id })).json;
  const api = createApi("http://caw.test", "runner:test-1", (url, init) => t.app.fetch(new Request(url, init)));
  return { ...t, project, a, card, api };
}

describe("createApi", () => {
  test("reads projects, workers and a card", async () => {
    const w = await world();
    expect((await w.api.projects()).map((p) => p.id)).toContain(w.project.id);
    expect((await w.api.workers()).map((x) => x.id)).toContain(w.a.id);
    expect((await w.api.card(w.card.id)).title).toBe(w.card.title);
  });

  test("a refused call throws RunnerApiError carrying status and the API's error code — never swallowed", async () => {
    const w = await world();
    const err = await w.api.startHop(w.project.id, { cardId: "00000000-0000-4000-8000-000000000000", workerId: w.a.id }).catch((e) => e);
    expect(err).toBeInstanceOf(RunnerApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
  });

  test("start → claim (once) → finish, every write named as the RUNNER (runner:<instance>, contract v1.2) — never as operator or worker", async () => {
    const w = await world();
    const actor = "runner:test-1";
    const hop = await w.api.startHop(w.project.id, { cardId: w.card.id, workerId: w.a.id });
    expect(hop.claimedBy).toBeNull();
    expect((await w.api.claimHop(hop.id, "inst-1")).claimedBy).toBe("inst-1");
    expect(await w.api.claimHop(hop.id, "inst-2").catch((e) => e.code)).toBe("already_claimed");
    const done = await w.api.finishHop(hop.id, { outcome: "commented", tokensIn: 5, tokensOut: 2, note: "n" });
    expect(done.outcome).toBe("commented");
    const events = await w.api.events(w.project.id, 0, 500);
    expect(events.filter((e) => e.type.startsWith("hop.")).map((e) => [e.type, e.actor])).toEqual([
      ["hop.started", actor], ["hop.claimed", actor], ["hop.finished", actor],
    ]);
  });
});

describe("createApi — failures name themselves", () => {
  test("a 2xx with an empty body is an error, not a null that fails later as a TypeError", async () => {
    const api = createApi("http://caw.test", "runner:test-1", () => new Response("", { status: 200 }));
    const err = await api.projects().catch((e) => e);
    expect(err).toBeInstanceOf(RunnerApiError);
    expect(err.code).toBe("bad_body");
  });
  test("a network failure says which call it was", async () => {
    const api = createApi("http://caw.test", "runner:test-1", () => { throw new Error("ECONNREFUSED"); });
    const err = await api.projects().catch((e) => e);
    expect(err.message).toContain("GET /v1/projects");
    expect(err.message).toContain("ECONNREFUSED");
  });
  test("a non-JSON error body keeps its first characters", async () => {
    const api = createApi("http://caw.test", "runner:test-1", () => new Response("<html>Bad gateway</html>", { status: 502 }));
    const err = await api.projects().catch((e) => e);
    expect([err.status, err.code]).toEqual([502, "bad_body"]);
    expect(err.message).toContain("Bad gateway");
  });
});
