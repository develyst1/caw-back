// The seam CAW calls (SPEC-A-008 § What I read): Blueprint's read API. A 404 is `null` (the thing does not exist);
// a network error, a 5xx or any other status is `BlueprintUnreachable` — never a null that reads as "not found".
// Spec content is only ever passed through (partContext), never kept.
export class BlueprintUnreachable extends Error {
  constructor(readonly reason: string) { super(`blueprint_unreachable (${reason})`); }
}

export type VersionFeed = {
  versions: { version: number; confirmedAt: string; confirmedBy: string; summary: unknown;
    changes: { added: string[]; changed: string[]; removed: string[] } }[];
  latest: { version: number; confirmedAt: string } | null;
  changedSinceLatest: boolean;
};

export type Blueprint = {
  getProject(bp: string): Promise<{ name: string } | null>;
  getVersion(bp: string, version: number): Promise<{ version: number; confirmedAt: string } | null>;
  /** Blueprint's PartContext exactly as returned, or null (404) */
  partContext(bp: string, version: number, key: string): Promise<unknown | null>;
  versionsAfter(bp: string, after: number): Promise<VersionFeed>;
};

/** `BLUEPRINT_URL`, or http://127.0.0.1:4200 when it is unset or empty (Bun loads an empty `.env` value as ""). */
export const defaultBlueprintUrl = (env: Record<string, string | undefined> = process.env) => env.BLUEPRINT_URL || "http://127.0.0.1:4200";

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
    async versionsAfter(bp, after) {
      const body = await get(`/v1/projects/${id(bp)}/versions?after=${after}`);
      if (body === null) throw new BlueprintUnreachable("project not found");
      return body as VersionFeed;
    },
  };
}
