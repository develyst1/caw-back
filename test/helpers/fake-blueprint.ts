// A fake Blueprint: a Bun server on a random port that answers with responses RECORDED from a real local
// blueprint-back (worked seed "จองห้องประชุม", one confirmed version) — test/fixtures/blueprint/*.json. Nothing here is invented.
import { readFileSync } from "node:fs";

const FIX = new URL("../fixtures/blueprint/", import.meta.url).pathname;
const fixture = (name: string) => readFileSync(`${FIX}${name}.json`, "utf8");

/** the Blueprint project id the fixtures were recorded for */
export const BP_PROJECT = (JSON.parse(fixture("project-200")) as { project: { id: string } }).project.id;
/** A SECOND Blueprint project for tests that need two different ones (D-082: one CAW project per Blueprint project). It is served the SAME
 *  recorded answers as BP_PROJECT — only the id the caller uses differs; nothing here is invented. */
export const BP_PROJECT_2 = "00000000-0000-4000-8000-0000000000b2";
export const BP_NAME = (JSON.parse(fixture("project-200")) as { project: { name: string } }).project.name;

const recorded = (id: string) => (id === BP_PROJECT_2 ? BP_PROJECT : id); // the second project is answered from the first one's recordings

// ---- SYNTHETIC v2 (REQ-105, SPEC-106 § Seam contract v2) — until recorded from a real blueprint-back (QA's joint run with TASK-113) ----
// Everything below the `spec` keys is built from the RECORDED v1 answers, reshaped to SPEC-106's v2 fields; each v2 answer is marked `// synthetic — SPEC-106 v2, until recorded`.
// `spec.version` (1–3) = which recorded version's part TEXT is "the current spec" (the recorded versions differ in the parts' titles, so a test changes the text by moving it);
// `spec.revision` = the spec revision; `spec.label` = the latest label or null (no label yet).
export type FakeSpec = { revision: number; version: 1 | 2 | 3; label: { version: number; label: string } | null; savedAt: string };
export type FakeChange = { rev: number; at: string; by: string | null; cause: string; added: string[]; changed: string[]; removed: string[] };

export function fakeBlueprint() {
  // `feed`: a SYNTHETIC change feed for one test (same shape as the recorded ones); null = serve the recorded feed-after-N.json.
  // `bodies`: the JSON of every POST (what caw-back sent: a locate request, an amendment) — for tests that assert what was sent.
  const mode = {
    down: false, calls: [] as string[], bodies: [] as { path: string; body: any }[], gone: new Set<string>() /* keys whose context is now 404: "the part was removed" */, feed: null as null | ((after: number) => unknown),
    spec: { revision: 1, version: 1, label: { version: 1, label: "v1" }, savedAt: "2026-10-14T09:01:08.146Z" } as FakeSpec, // synthetic — SPEC-106 v2, until recorded
    changes: [] as FakeChange[], // synthetic — SPEC-106 v2 route 4 (`/spec/changes`), until recorded
    changesBody: null as unknown, // synthetic: non-null = answer `/spec/changes` with exactly this body (a reply that is not a change feed)
    // synthetic — SPEC-106 v2 route 1 + the REQ-112 addition, until recorded (TASK-121): what `/spec` lists as `parts` / `links` (default none — CAW reads only `revision` and `latestLabel` elsewhere),
    // `related` = the `relatedDecisions` a part's context carries (merged with `relatedDecisionsMore: false`), `decisionsOn` = the `decisions` it carries instead of the recorded ones
    snapshot: null as null | { parts: unknown[]; links: unknown[] },
    related: {} as Record<string, { via: string; decision: unknown }[]>,
    decisionsOn: {} as Record<string, unknown[]>,
    pageSize: 0, // synthetic: > 0 = answer at most this many change sets and say `more: true` while sets remain (0 = all at once)
  };
  // synthetic — SPEC-106 v2, until recorded: the label as route 1/2/4 show it
  const latestLabel = () => (mode.spec.label ? { ...mode.spec.label, labelledAt: mode.spec.savedAt, by: "โด่ง" } : null);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname + new URL(req.url).search;
      mode.calls.push(`${req.method} ${path}`);
      const json = (name: string, status = 200) => new Response(fixture(name), { status, headers: { "content-type": "application/json" } });
      if (mode.down) return new Response("boom", { status: 500 });
      if (req.method === "POST") {
        const body = await req.json();
        mode.bodies.push({ path, body });
        const post = /^\/v1\/projects\/([^/]+)\/(locate|spec\/locate|amendments)$/.exec(path);
        if (!post || recorded(post[1]!) !== BP_PROJECT) return json("project-404", 404);
        const located = () => (body.request.includes("ห้องใหญ่") ? "locate-room" : body.request.includes("ค้นหาห้อง") ? "locate-search" : "locate-none");
        if (post[2] === "locate") return json(located());
        // synthetic — SPEC-106 v2 route 3, until recorded: the recorded `Located`, with the spec revision in place of the version; it never refuses for "no version"
        if (post[2] === "spec/locate") { const { version: _v, ...rest } = JSON.parse(fixture(located())); return Response.json({ revision: mode.spec.revision, ...rest }); }
        return (body.about ?? []).includes("NOPE-999") ? json("amendment-400-about", 400) : json("amendment-201", 201); // the recorded Message, whatever `from` says
      }
      const m = /^\/v1\/projects\/([^/]+)(\/.*)?$/.exec(path);
      if (!m) return json("project-404", 404);
      if (recorded(m[1]!) !== BP_PROJECT) return json("project-404", 404);
      const rest = m[2] ?? "";
      if (rest === "") return json("project-200");
      // synthetic — SPEC-106 v2 route 1, until recorded: CAW reads only `revision` and `latestLabel` from it, so `parts` / `links` are empty here
      if (rest === "/spec") return Response.json({ projectId: m[1], revision: mode.spec.revision, savedAt: mode.spec.savedAt, latestLabel: latestLabel(), parts: mode.snapshot?.parts ?? [], links: mode.snapshot?.links ?? [] });
      // synthetic — SPEC-106 v2 route 2, until recorded: the recorded context of the chosen version, `version`/`confirmedAt` replaced by `revision`, `savedAt`, `latestLabel`
      const specCtx = /^\/spec\/parts\/(STEP-00[1-6]|DEC-001|API-001|INT-00[23]|SCR-001)\/context$/.exec(rest);
      if (specCtx) {
        if (mode.gone.has(specCtx[1]!)) return Response.json({ error: { code: "not_found", message: `part ${specCtx[1]}` } }, { status: 404 });
        const { version: _v, confirmedAt: _c, ...recordedCtx } = JSON.parse(fixture(`context-v${mode.spec.version}-${specCtx[1]!.toLowerCase()}`));
        const key = specCtx[1]!;
        // synthetic — SPEC-106 REQ-112 addition, until recorded: `relatedDecisions` only when a test set them for this part (a v2 Blueprint before TASK-117 has no such field)
        const rel = mode.related[key] ? { relatedDecisions: mode.related[key], relatedDecisionsMore: false } : {};
        const dec = mode.decisionsOn[key] ? { decisions: mode.decisionsOn[key] } : {};
        return Response.json({ ...recordedCtx, ...dec, ...rel, revision: mode.spec.revision, savedAt: mode.spec.savedAt, latestLabel: latestLabel() });
      }
      if (/^\/spec\/parts\/[^/]+\/context$/.test(rest)) return Response.json({ error: { code: "not_found", message: "part" } }, { status: 404 });
      // synthetic — SPEC-106 v2 route 4, until recorded: the change sets a test put in `mode.changes`, after the asked revision
      const specChanges = /^\/spec\/changes\?after=(\d+)$/.exec(rest);
      if (specChanges && mode.changesBody !== null) return Response.json(mode.changesBody);
      if (specChanges) {
        const after = mode.changes.filter((c) => c.rev > Number(specChanges[1])).sort((a, b) => a.rev - b.rev);
        const page = mode.pageSize > 0 ? after.slice(0, mode.pageSize) : after;
        return Response.json({ revision: mode.spec.revision, latestLabel: latestLabel(), changes: page, more: page.length < after.length });
      }
      const exact = /^\/versions\/([123])$/.exec(rest);
      if (exact) return json(`version-${exact[1]}-200`); // the recorded real versions 1–3 of the worked seed
      if (/^\/versions\/\d+$/.test(rest)) return json("version-9-404", 404);
      const feed = /^\/versions\?after=(\d+)$/.exec(rest);
      if (feed && mode.feed) return Response.json(mode.feed(Number(feed[1])));
      if (feed && Number(feed[1]) <= 3) return json(`feed-after-${feed[1]}`);
      const ctx = /^\/versions\/([123])\/parts\/(STEP-00[1-6]|DEC-001|API-001|INT-00[23]|SCR-001)\/context$/.exec(rest); // the keys a locate finds + the six steps, recorded at v1, v2 and v3
      if (ctx) return mode.gone.has(ctx[2]!) ? json("context-404", 404) : json(`context-v${ctx[1]}-${ctx[2]!.toLowerCase()}`);
      if (/^\/versions\/\d+\/parts\/[^/]+\/context$/.test(rest)) return json("context-404", 404);
      return json("project-404", 404);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, mode, stop: () => server.stop(true) };
}
