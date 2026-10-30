// The seam CAW calls (SPEC-A-008 § What I read): Blueprint's read API. A 404 is `null` (the thing does not exist);
// a network error, a 5xx or any other status is `BlueprintUnreachable` — never a null that reads as "not found".
// Spec content is passed through as returned. Since REQ-105 (SPEC-107 D3) a part's last-read body is kept in two operational tables — blueprint/latest.ts — and nowhere else.
export class BlueprintUnreachable extends Error {
  constructor(readonly reason: string) { super(`blueprint_unreachable (${reason})`); }
}

export type VersionFeed = {
  versions: { version: number; confirmedAt: string; confirmedBy: string; summary: unknown;
    changes: { added: string[]; changed: string[]; removed: string[] } }[];
  latest: { version: number; confirmedAt: string } | null;
  changedSinceLatest: boolean;
};

/** SPEC-106 § Seam contract v2: a label is a tag on a moment of the spec, not a gate */
export type LatestLabel = { version: number; label: string; labelledAt?: string; by?: string };
/** SPEC-106 route 1 — the current spec in one read; `revision` counts change sets (0 = none yet) */
export type SpecSnapshot = { projectId: string; revision: number; savedAt: string | null; latestLabel: LatestLabel | null; parts: unknown[]; links: unknown[] };
/** SPEC-106 route 4 — one entry per change set after `after`, ascending; `more` = ask again from the last `rev` */
export type SpecChange = { rev: number; at: string; by: string | null; cause: string; added: string[]; changed: string[]; removed: string[] };
export type SpecChanges = { revision: number; latestLabel: LatestLabel | null; changes: SpecChange[]; more?: boolean };

export type Blueprint = {
  getProject(bp: string): Promise<{ name: string } | null>;
  /** v2 route 1 (SPEC-107 D1): the current spec, or null (404 = no such project); anything else but a 200 is `BlueprintUnreachable` */
  spec(bp: string): Promise<SpecSnapshot | null>;
  /** v2 route 2: Blueprint's context for one part of the CURRENT spec exactly as returned (`revision`, `savedAt`, `latestLabel`, …), or null (404 = the key is not live) */
  specContext(bp: string, key: string): Promise<unknown | null>;
  /** v2 route 3: Blueprint's `Located` against the current spec, as returned; anything but a 200 is `BlueprintUnreachable` */
  specLocate(bp: string, request: string): Promise<unknown>;
  /** v2 route 4: what changed after a revision. A 404 (no such project) is `BlueprintUnreachable`, like `versionsAfter` */
  specChanges(bp: string, after: number): Promise<SpecChanges>;
  getVersion(bp: string, version: number): Promise<{ version: number; confirmedAt: string } | null>;
  /** Blueprint's PartContext exactly as returned, or null (404) */
  partContext(bp: string, version: number, key: string): Promise<unknown | null>;
  versionsAfter(bp: string, after: number): Promise<VersionFeed>;
  /** Blueprint's `Located` exactly as returned (SPEC-A-005 § 2); anything but a 200 is `BlueprintUnreachable` */
  locate(bp: string, request: string): Promise<unknown>;
  /** Blueprint's amendment (SPEC-A-005 § 4): its `Message` as returned, or its own 400 (an unknown `about` key …) */
  amend(bp: string, body: { from: string; request: string; about?: string[] }): Promise<{ ok: true; message: unknown } | { ok: false; error: { code: string; message: string } }>;
};

/** `BLUEPRINT_URL`, or http://127.0.0.1:4200 when it is unset or empty (Bun loads an empty `.env` value as ""). */
export const defaultBlueprintUrl = (env: Record<string, string | undefined> = process.env) => env.BLUEPRINT_URL || "http://127.0.0.1:4200";

/** Where Blueprint's web app is (for the link CAW puts on an amendment): `BLUEPRINT_WEB_URL`, or http://127.0.0.1:3100 when unset or empty. */
export const defaultWebUrl = (env: Record<string, string | undefined> = process.env) => (env.BLUEPRINT_WEB_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");

export function createBlueprint(baseUrl: string = defaultBlueprintUrl()): Blueprint {
  const get = async (path: string): Promise<unknown | null> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`);
    } catch {
      throw new BlueprintUnreachable("network");
    }
    if (res.status === 404) return null;
    if (res.status !== 200) throw new BlueprintUnreachable(`status ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new BlueprintUnreachable("not json");
    }
  };
  const post = async (path: string, body: unknown): Promise<{ status: number; json: any }> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new BlueprintUnreachable("network");
    }
    let json: unknown;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  };
  const id = encodeURIComponent;
  return {
    async getProject(bp) {
      const body = (await get(`/v1/projects/${id(bp)}`)) as { project: { name: string } } | null;
      return body ? { name: body.project.name } : null;
    },
    async getVersion(bp, version) {
      const body = (await get(`/v1/projects/${id(bp)}/versions/${version}`)) as { version: number; confirmedAt: string } | null;
      return body ? { version: body.version, confirmedAt: body.confirmedAt } : null;
    },
    partContext: (bp, version, key) => get(`/v1/projects/${id(bp)}/versions/${version}/parts/${id(key)}/context`),
    async spec(bp) { return (await get(`/v1/projects/${id(bp)}/spec`)) as SpecSnapshot | null; },
    specContext: (bp, key) => get(`/v1/projects/${id(bp)}/spec/parts/${id(key)}/context`),
    async specLocate(bp, request) {
      const r = await post(`/v1/projects/${id(bp)}/spec/locate`, { request });
      if (r.status !== 200 || r.json === null) throw new BlueprintUnreachable(`status ${r.status}`);
      return r.json;
    },
    async specChanges(bp, after) {
      const body = await get(`/v1/projects/${id(bp)}/spec/changes?after=${after}`);
      if (body === null) throw new BlueprintUnreachable("project not found");
      return body as SpecChanges;
    },
    async locate(bp, request) {
      const r = await post(`/v1/projects/${id(bp)}/locate`, { request });
      if (r.status !== 200 || r.json === null) throw new BlueprintUnreachable(`status ${r.status}`);
      return r.json;
    },
    async amend(bp, body) {
      const r = await post(`/v1/projects/${id(bp)}/amendments`, body);
      if (r.status === 201 && r.json !== null) return { ok: true, message: r.json };
      if (r.status === 400 && r.json?.error?.message) return { ok: false, error: { code: String(r.json.error.code ?? "validation"), message: String(r.json.error.message) } };
      throw new BlueprintUnreachable(`status ${r.status}`);
    },
    async versionsAfter(bp, after) {
      const body = await get(`/v1/projects/${id(bp)}/versions?after=${after}`);
      if (body === null) throw new BlueprintUnreachable("project not found");
      return body as VersionFeed;
    },
  };
}
