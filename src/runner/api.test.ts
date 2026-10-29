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

  test("hopOutput sends a batch as the RUNNER (POST /v1/hops/{id}/output, { entries }) → { stored }; the same batch again → stored 0; an unknown hop throws not_found", async () => {
    const w = await world();
    const hop = await w.api.startHop(w.project.id, { cardId: w.card.id, workerId: w.a.id });
    const batch = [{ seq: 0, at: "2026-10-29T10:00:00.000Z", kind: "line" as const, text: "● session x" }, { seq: 1, at: "2026-10-29T10:00:05.000Z", kind: "gap" as const, text: "", gapSeconds: 4 }];
    expect(await w.api.hopOutput(hop.id, batch)).toEqual({ stored: 2 });
    expect(await w.api.hopOutput(hop.id, batch)).toEqual({ stored: 0 });
    expect((await w.call("GET", `/v1/hops/${hop.id}/output`)).json.entries.map((e: any) => [e.seq, e.kind, e.gapSeconds])).toEqual([[0, "line", null], [1, "gap", 4]]);
    const err = await w.api.hopOutput("00000000-0000-4000-8000-000000000099", batch).catch((e) => e);
    expect(err).toBeInstanceOf(RunnerApiError);
    expect([err.status, err.code]).toEqual([404, "not_found"]);
  });

  test("hopOutput names the runner in x-caw-actor and puts the entries in a JSON body", async () => {
    const seen: { call?: { url: string; actor: string | null; body: unknown } } = {};
    const api = createApi("http://caw.test", "runner:test-1", (url, init) => {
      seen.call = { url, actor: new Headers(init?.headers).get("x-caw-actor"), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ stored: 1 }), { status: 202 });
    });
    await api.hopOutput("a b", [{ seq: 3, at: "2026-10-29T10:00:00.000Z", kind: "truncated", text: "" }]);
    expect(seen.call).toEqual({ url: "http://caw.test/v1/hops/a%20b/output", actor: "runner:test-1", body: { entries: [{ seq: 3, at: "2026-10-29T10:00:00.000Z", kind: "truncated", text: "" }] } });
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
