// The seam proxy (SPEC-A-008 v1.4): `locate` and `amendments` go to Blueprint through CAW. The caller is the operator, or a worker holding
// a running chat hop on some message of the project. Blueprint's answer is passed on AS RETURNED; CAW keeps NO spec text — a worker's hop
// keeps only the located KEYS (hop.located, v1.6). Blueprint not answering → 502.
import type { Blueprint } from "../blueprint/client";
import { chatHopOf } from "../chat/guard";
import type { Actor } from "../core/events";
import { now } from "../core/ids";
import { loadState } from "../core/state";
import { writeDecided } from "../core/write";
import type { Db } from "../db/client";
import { workerIdOf } from "../http/actor";
import { ApiError, notFound } from "../http/errors";

async function project(db: Db, projectId: string) {
  const s = await loadState(db, projectId);
  return { s, project: s.project ?? (() => { throw notFound("project"); })() };
}

export async function locate(db: Db, blueprint: Blueprint, actor: Actor, hopId: string | null, projectId: string, request: string): Promise<unknown> {
  const { s, project: p } = await project(db, projectId);
  const hop = workerIdOf(actor) === null ? null : chatHopOf(s, actor, hopId);
  const located = await blueprint.locate(p.blueprintProjectId, request);
  const keys = ((located as { candidates?: { key: string }[] }).candidates ?? []).map((c) => c.key);
  if (hop && keys.length) {
    // the hop keeps the keys, not the result; the hop must still be running when they are written
    await writeDecided(db, projectId, (cur) => {
      chatHopOf(cur, actor, hop.id);
      return { type: "hop.located", projectId, actor, at: now(), data: { hopId: hop.id, keys } };
    });
  }
  return located;
}

/** `from` is filled by the core: caw:<projectId>:<hopId> (…:operator when the operator sends it). */
export async function amend(db: Db, blueprint: Blueprint, actor: Actor, hopId: string | null, projectId: string, input: { request: string; about?: string[] }): Promise<unknown> {
  const { s, project: p } = await project(db, projectId);
  const hop = workerIdOf(actor) === null ? null : chatHopOf(s, actor, hopId);
  const sent = await blueprint.amend(p.blueprintProjectId, { from: `caw:${projectId}:${hop?.id ?? "operator"}`, request: input.request, ...(input.about ? { about: input.about } : {}) });
  if (!sent.ok) throw new ApiError(400, "amendment_refused", sent.error.message);
  return sent.message;
}
