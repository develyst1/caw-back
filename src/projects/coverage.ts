// Which rules of the spec does no card cover? (REQ-112, SPEC-109 D2.) Computed on demand from Blueprint's CURRENT spec, advisory only — it never blocks anything (D4).
//   anchors   = the anchor keys of every WORK card of the project (any status — a done card covered its rules), plus the open proposal's item anchors when one is asked for;
//   covered   = each anchor that is itself a decision, plus every decision its context lists in `decisions` and `relatedDecisions[].decision`;
//   uncovered = every `decision` part of the spec not covered, grouped under the parts it `covers` (a decision that covers nothing is grouped under itself).
// Nothing is stored: the answer is kept in process memory per (project, spec revision, anchors) — the board asks again whenever the event log grows.
import type { Blueprint } from "../blueprint/client";
import { readLatestPart } from "../blueprint/latest";
import { loadState } from "../core/state";
import type { Db } from "../db/client";
import { ApiError, notFound } from "../http/errors";

export type Uncovered = { key: string; kind: string; title: string; decisions: string[] };
export type Coverage = { revision: number; uncovered: Uncovered[] };

const MEMO_MAX = 200;
const memo = new Map<string, Coverage>(); // insertion order = age: the oldest entry goes first

type SpecPart = { key: string; kind: string; title: string };
type SpecLink = { kind: string; fromKey: string; toKey: string };

/** a decision as a context lists it: a part (`{ key, … }`) — a bare key is read too */
const keyOf = (x: unknown): string | null => (typeof x === "string" ? x : typeof (x as { key?: unknown } | null)?.key === "string" ? (x as { key: string }).key : null);
const listOf = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

export async function coverage(db: Db, blueprint: Blueprint, projectId: string, proposalId?: string): Promise<Coverage> {
  const state = await loadState(db, projectId);
  const project = state.project ?? (() => { throw notFound("project"); })();
  // a proposal of another project is not in this project's state: the same 404
  const proposal = proposalId === undefined ? null : state.proposals.find((p) => p.id === proposalId) ?? (() => { throw notFound("proposal"); })();
  const anchors = [...new Set([...state.cards.filter((c) => c.kind === "work").map((c) => c.anchorKey), ...(proposal ? proposal.items.map((i) => i.anchor.key) : [])])].sort();

  const spec = await blueprint.spec(project.blueprintProjectId); // a Blueprint that does not answer → BlueprintUnreachable → 502, as every read
  if (spec === null) throw new ApiError(404, "blueprint_project_not_found", `Blueprint has no project ${project.blueprintProjectId}`);
  const memoKey = `${projectId}|${spec.revision}|${anchors.join(",")}`;
  const hit = memo.get(memoKey);
  if (hit) return hit;

  const parts = listOf(spec.parts) as SpecPart[];
  const links = listOf(spec.links) as SpecLink[];
  const partOf = new Map(parts.map((p) => [p.key, p]));

  const covered = new Set<string>();
  for (const key of anchors) {
    if (partOf.get(key)?.kind === "decision") covered.add(key);
    const read = await readLatestPart(db, blueprint, project, key);
    if (read === null) continue; // the part is gone: it covers nothing
    const body = (read.body ?? {}) as { decisions?: unknown; relatedDecisions?: unknown };
    for (const d of listOf(body.decisions)) { const k = keyOf(d); if (k) covered.add(k); }
    for (const r of listOf(body.relatedDecisions)) { const k = keyOf((r as { decision?: unknown } | null)?.decision); if (k) covered.add(k); }
  }

  const under = new Map<string, Set<string>>(); // part key → the uncovered decisions that cover it
  for (const d of parts.filter((p) => p.kind === "decision" && !covered.has(p.key))) {
    const targets = links.filter((l) => l.kind === "covers" && l.fromKey === d.key).map((l) => l.toKey);
    for (const t of targets.length ? targets : [d.key]) under.set(t, (under.get(t) ?? new Set()).add(d.key));
  }
  const uncovered = [...under].map(([key, ds]): Uncovered => ({ key, kind: partOf.get(key)?.kind ?? "", title: partOf.get(key)?.title ?? "", decisions: [...ds].sort() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const answer: Coverage = { revision: spec.revision, uncovered };
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!);
  memo.set(memoKey, answer);
  return answer;
}
