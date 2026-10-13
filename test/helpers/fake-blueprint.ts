// A fake Blueprint: a Bun server on a random port that answers with responses RECORDED from a real local
// blueprint-back (worked seed "จองห้องประชุม", one confirmed version) — test/fixtures/blueprint/*.json. Nothing here is invented.
import { readFileSync } from "node:fs";

const FIX = new URL("../fixtures/blueprint/", import.meta.url).pathname;
const fixture = (name: string) => readFileSync(`${FIX}${name}.json`, "utf8");

/** the Blueprint project id the fixtures were recorded for */
export const BP_PROJECT = (JSON.parse(fixture("project-200")) as { project: { id: string } }).project.id;
export const BP_NAME = (JSON.parse(fixture("project-200")) as { project: { name: string } }).project.name;

export function fakeBlueprint() {
  // `feed`: a SYNTHETIC change feed for one test (same shape as the recorded ones); null = serve the recorded feed-after-N.json.
  const mode = { down: false, calls: [] as string[], feed: null as null | ((after: number) => unknown) };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname + new URL(req.url).search;
      mode.calls.push(`${req.method} ${path}`);
      const json = (name: string, status = 200) => new Response(fixture(name), { status, headers: { "content-type": "application/json" } });
      if (mode.down) return new Response("boom", { status: 500 });
      const m = /^\/v1\/projects\/([^/]+)(\/.*)?$/.exec(path);
      if (!m) return json("project-404", 404);
      if (m[1] !== BP_PROJECT) return json("project-404", 404);
      const rest = m[2] ?? "";
      if (rest === "") return json("project-200");
      const exact = /^\/versions\/([123])$/.exec(rest);
      if (exact) return json(`version-${exact[1]}-200`); // the recorded real versions 1–3 of the worked seed
      if (/^\/versions\/\d+$/.test(rest)) return json("version-9-404", 404);
      const feed = /^\/versions\?after=(\d+)$/.exec(rest);
      if (feed && mode.feed) return Response.json(mode.feed(Number(feed[1])));
      if (feed && Number(feed[1]) <= 3) return json(`feed-after-${feed[1]}`);
      const ctx = /^\/versions\/([12])\/parts\/(STEP-00[1-6])\/context$/.exec(rest); // the six steps of the worked seed, recorded at v1 and v2
      if (ctx) return json(`context-v${ctx[1]}-${ctx[2]!.toLowerCase()}`);
      if (/^\/versions\/\d+\/parts\/[^/]+\/context$/.test(rest)) return json("context-404", 404);
      return json("project-404", 404);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, mode, stop: () => server.stop(true) };
}
