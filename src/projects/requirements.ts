// The requirements of Blueprint's CURRENT spec, for the entry chat hop (REQ-118, SPEC-117 D2.1). Read only, nothing is stored: every `requirement` part of `/spec`
// (seam route 1), with its text, in key order — `REQ-002` before `REQ-010`. The runner puts them in the chat hop's system prompt.
import type { Blueprint } from "../blueprint/client";
import { loadState } from "../core/state";
import type { Db } from "../db/client";
import { ApiError, notFound } from "../http/errors";

export type Requirements = { revision: number; requirements: { key: string; title: string; text: string }[] };

type SpecPart = { key?: unknown; kind?: unknown; title?: unknown; body?: { text?: unknown } | null };

export async function requirements(db: Db, blueprint: Blueprint, projectId: string): Promise<Requirements> {
  const { project } = await loadState(db, projectId);
  if (!project) throw notFound("project");
  const spec = await blueprint.spec(project.blueprintProjectId); // a Blueprint that does not answer → BlueprintUnreachable → 502, as every read
  if (spec === null) throw new ApiError(404, "blueprint_project_not_found", `Blueprint has no project ${project.blueprintProjectId}`);
  const found = (Array.isArray(spec.parts) ? spec.parts as SpecPart[] : []).filter((p) => p?.kind === "requirement" && typeof p.key === "string");
  return {
    revision: spec.revision,
    requirements: found.map((p) => ({ key: p.key as string, title: typeof p.title === "string" ? p.title : "", text: typeof p.body?.text === "string" ? p.body.text : "" }))
      .sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true })),
  };
}
