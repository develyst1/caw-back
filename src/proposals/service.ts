// Proposals (SPEC-A-008 v1.4 + v1.6, REQ-013): the entry worker's chat hop proposes cards; the operator accepts. A proposal's items are
// CAW's own words + anchors { key, version } — never spec text. Anchors are checked against Blueprint (outside the write lock, a network
// call) and a proposal may anchor only on keys its hop LOCATED (v1.6).
import { eq } from "drizzle-orm";
import type { Blueprint } from "../blueprint/client";
import { chatHopOf } from "../chat/guard";
import type { Actor, ProposalItem } from "../core/events";
import { newId, now } from "../core/ids";
import type { ProposalState, State } from "../core/reduce";
import { isUuid, loadState } from "../core/state";
import { writeDecided } from "../core/write";
import type { Db } from "../db/client";
import { proposals } from "../db/schema";
import { requireOperator } from "../http/actor";
import { ApiError, notFound } from "../http/errors";
import { type Card, cardView } from "../cards/view";

export type Proposal = ProposalState & { hopsTotal: number };
/** `hopsTotal` is computed on read — the sum of the items' hops — never stored (harness §9). */
export const proposalView = (p: ProposalState): Proposal => ({ ...p, hopsTotal: p.items.reduce((n, i) => n + i.hops, 0) });

const projectIn = (s: State) => s.project ?? (() => { throw notFound("project"); })();
const bad = (message: string) => new ApiError(400, "validation", message);

/** dependsOn indexes: in range, not itself, no repeats, acyclic */
function checkDependencies(items: ProposalItem[]): void {
  items.forEach((item, i) => {
    if (new Set(item.dependsOn).size !== item.dependsOn.length) throw bad(`items[${i}].dependsOn lists an index twice`);
    for (const j of item.dependsOn) {
      if (j < 0 || j >= items.length) throw bad(`items[${i}].dependsOn: ${j} is not an item index`);
      if (j === i) throw bad(`items[${i}] depends on itself`);
    }
  });
  const state = items.map(() => 0 as 0 | 1 | 2); // 0 new · 1 on the path · 2 done
  const visit = (i: number): void => {
    if (state[i] === 2) return;
    if (state[i] === 1) throw bad("the items' dependencies form a cycle");
    state[i] = 1;
    for (const j of items[i]!.dependsOn) visit(j);
    state[i] = 2;
  };
  items.forEach((_, i) => visit(i));
}

/** Everything about a proposal that needs only CAW's own state (members, dependencies, the hop's located keys) — before any Blueprint call. */
function check(s: State, actor: Actor, hopId: string | null, input: { messageId: string; items: ProposalItem[] }) {
  projectIn(s);
  const hop = chatHopOf(s, actor, hopId, input.messageId);
  for (const [i, item] of input.items.entries()) {
    if (!s.members.includes(item.workerId)) throw new ApiError(400, "not_a_member", `items[${i}].workerId ${item.workerId} is not in this project's chain`);
  }
  checkDependencies(input.items);
  // v1.6 (W10, "cards only from what locate found"): before the Blueprint check
  const located = new Set(hop.locatedKeys ?? []);
  const missing = [...new Set(input.items.map((i) => i.anchor.key).filter((k) => !located.has(k)))];
  if (missing.length) throw new ApiError(422, "anchor_not_located", "an item is anchored on a key this hop did not locate", { keys: missing });
}

/** Each distinct anchor must be a part of a confirmed version of the project's Blueprint project — as a card's anchor is (A-072). */
async function checkAnchors(blueprint: Blueprint, bp: string, items: ProposalItem[]): Promise<void> {
  const versions = new Map<number, boolean>();
  for (const { anchor } of items) {
    if (!versions.has(anchor.version)) versions.set(anchor.version, (await blueprint.getVersion(bp, anchor.version)) !== null);
    if (!versions.get(anchor.version)) throw new ApiError(422, "version_not_confirmed", `version ${anchor.version} is not a confirmed version of this project's Blueprint project`);
  }
  const seen = new Set<string>();
  for (const { anchor } of items) {
    const id = `${anchor.version}|${anchor.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if ((await blueprint.partContext(bp, anchor.version, anchor.key)) === null) throw new ApiError(422, "anchor_not_in_version", `${anchor.key} is not a part of version ${anchor.version}`);
  }
}

export async function propose(db: Db, blueprint: Blueprint, actor: Actor, hopId: string | null, projectId: string,
  input: { messageId: string; items: ProposalItem[] }): Promise<Proposal> {
  const before = await loadState(db, projectId);
  check(before, actor, hopId, input);
  await checkAnchors(blueprint, projectIn(before).blueprintProjectId, input.items);
  const id = newId();
  const { state } = await writeDecided(db, projectId, (s) => {
    check(s, actor, hopId, input); // again, on the state the write sees
    return { type: "proposal.made", projectId, actor, at: now(), data: {
      id, messageId: input.messageId, version: Math.max(...input.items.map((i) => i.anchor.version)), items: input.items,
      // an older OPEN proposal on the same message is superseded in this same event
      supersedes: s.proposals.filter((p) => p.messageId === input.messageId && p.status === "open").map((p) => p.id),
    } };
  });
  return proposalView(state.proposals.find((p) => p.id === id)!);
}

/** Newest first. */
export async function listProposals(db: Db, projectId: string, messageId?: string): Promise<Proposal[]> {
  const s = await loadState(db, projectId);
  projectIn(s);
  return s.proposals.filter((p) => messageId === undefined || p.messageId === messageId).sort((a, b) => (a.id < b.id ? 1 : -1)).map(proposalView);
}

// Accept (the operator): the anchors are re-checked against Blueprint first — any gone → 422, nothing written — then ONE transaction:
// a `card.created` per item (dependencies mapped from indexes to the new ids, assignee = the item's worker) and `proposal.accepted`.
export async function accept(db: Db, blueprint: Blueprint, actor: Actor, proposalId: string): Promise<Card[]> {
  requireOperator(actor);
  const [row] = isUuid(proposalId) ? await db.select({ projectId: proposals.projectId }).from(proposals).where(eq(proposals.id, proposalId)) : [];
  if (!row) throw notFound("proposal");
  const projectId = row.projectId;
  const before = await loadState(db, projectId);
  const found = before.proposals.find((p) => p.id === proposalId) ?? (() => { throw notFound("proposal"); })();
  if (found.status !== "open") throw new ApiError(409, "not_open", `that proposal is ${found.status}`);
  await checkAnchors(blueprint, projectIn(before).blueprintProjectId, found.items);
  const ids = found.items.map(() => newId());
  const { state } = await writeDecided(db, projectId, (s) => {
    const p = s.proposals.find((x) => x.id === proposalId) ?? (() => { throw notFound("proposal"); })();
    if (p.status !== "open") throw new ApiError(409, "not_open", `that proposal is ${p.status}`);
    for (const [i, item] of p.items.entries()) {
      if (!s.members.includes(item.workerId)) throw new ApiError(400, "not_a_member", `items[${i}].workerId ${item.workerId} is no longer in this project's chain`);
    }
    const at = now();
    const first = Math.max(0, ...s.cards.map((c) => c.number)) + 1;
    return [
      ...p.items.map((item, i) => ({ type: "card.created" as const, projectId, actor, at, data: {
        id: ids[i]!, number: first + i, title: item.title, todo: item.todo, anchor: item.anchor, assigneeId: item.workerId, dependsOn: item.dependsOn.map((j) => ids[j]!),
      } })),
      { type: "proposal.accepted" as const, projectId, actor, at, data: { proposalId, cardIds: ids } },
    ];
  });
  return ids.map((id) => cardView(state, state.cards.find((c) => c.id === id)!));
}
