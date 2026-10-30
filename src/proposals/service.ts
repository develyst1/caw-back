// Proposals (SPEC-A-008 v1.4 + v1.6, REQ-013): the entry worker's chat hop proposes cards; the operator accepts. A proposal's items are
// CAW's own words + anchors { key, version } — never spec text. Anchors are checked against Blueprint (outside the write lock, a network
// call) and a proposal may anchor only on keys its hop LOCATED (v1.6).
import { eq } from "drizzle-orm";
import type { Blueprint } from "../blueprint/client";
import { cardAnchor, labelOf, readLatestPart, type LatestRead } from "../blueprint/latest";
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

export type Proposal = ProposalState & { hopsTotal: number; onBoard: number[] };
/** REQ-126 r2 (SPEC-126 D1): the work already on the board = the anchor keys of the project's OPEN work cards (not done), except a card whose part has left the spec (REQ-105 D12). Never the wording. */
const liveCards = (s: State, key?: string) => s.cards.filter((c) => c.kind === "work" && c.status !== "done" && c.anchorRemovedRevision === null && (key === undefined || c.anchorKey === key));
/** The indexes of an OPEN proposal's items whose anchor key is already on the board; [] for an accepted or superseded one. */
export function onBoardOf(s: State, p: ProposalState): number[] {
  if (p.status !== "open") return [];
  const keys = new Set(liveCards(s).map((c) => c.anchorKey));
  return p.items.flatMap((item, i) => (keys.has(item.anchor.key) ? [i] : []));
}
/** `hopsTotal` and `onBoard` are computed on read — never stored (harness §9). */
export const proposalView = (s: State, p: ProposalState): Proposal => ({ ...p, hopsTotal: p.items.reduce((n, i) => n + i.hops, 0), onBoard: onBoardOf(s, p) });

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
  // REQ-118 (SPEC-117 D2.4): a not-located key that looks like a requirement (Blueprint's `REQ-` prefix) is not refused here — `propose` reads it and accepts it only when the part IS a requirement.
  // The prefix only decides whether to READ; any other not-located key is refused now, before any Blueprint call.
  const refused = missing.filter((k) => !k.startsWith(REQUIREMENT_PREFIX));
  if (refused.length) throw new ApiError(422, "anchor_not_located", "an item is anchored on a key this hop did not locate", { keys: missing });
  return missing; // the not-located `REQ-` keys, for the read
}

const REQUIREMENT_PREFIX = "REQ-";

/** The not-located `REQ-` keys of an item list must each be a `requirement` part of the current spec (cache-aware read) — otherwise 422 `anchor_not_located`, as for any other not-located key. */
async function checkRequirementAnchors(db: Db, blueprint: Blueprint, project: { id: string; blueprintProjectId: string }, keys: string[]): Promise<void> {
  const notRequirements: string[] = [];
  for (const key of keys) {
    const read = await readLatestPart(db, blueprint, project, key);
    if ((read?.body as { part?: { kind?: unknown } } | null | undefined)?.part?.kind !== "requirement") notRequirements.push(key);
  }
  if (notRequirements.length) throw new ApiError(422, "anchor_not_located", "an item is anchored on a key this hop did not locate", { keys: notRequirements });
}

/** REQ-105 (SPEC-107 D4): each distinct anchor key must be live in Blueprint's CURRENT spec — read once per key (cache-aware: Blueprint down → the last body read). Returns what each read
 *  said, by key, so the caller can store the label number / words / revision the card or proposal is cut at. A `version` on an item is ignored. */
async function checkAnchors(db: Db, blueprint: Blueprint, project: { id: string; blueprintProjectId: string }, items: { anchor: { key: string } }[]): Promise<Map<string, LatestRead>> {
  const reads = new Map<string, LatestRead>();
  for (const { anchor } of items) {
    if (reads.has(anchor.key)) continue;
    const read = await readLatestPart(db, blueprint, project, anchor.key);
    if (read === null) throw new ApiError(422, "anchor_not_in_version", `${anchor.key} is not a part of Blueprint's current spec`);
    reads.set(anchor.key, read);
  }
  return reads;
}

/** an item as it arrives: `anchor.version` is optional and ignored (REQ-105) */
export type ProposalItemIn = Omit<ProposalItem, "anchor"> & { anchor: { key: string; version?: number } };

export async function propose(db: Db, blueprint: Blueprint, actor: Actor, hopId: string | null, projectId: string,
  input: { messageId: string; items: ProposalItemIn[] }): Promise<Proposal> {
  const before = await loadState(db, projectId);
  // `check` needs only anchor.key; the items are STORED with the label number the read carried (D2: 0 = none), so a stored proposal always has a number
  const notLocatedRequirements = check(before, actor, hopId, { messageId: input.messageId, items: input.items.map((i) => ({ ...i, anchor: { key: i.anchor.key, version: 0 } })) });
  await checkRequirementAnchors(db, blueprint, projectIn(before), notLocatedRequirements);
  const reads = await checkAnchors(db, blueprint, projectIn(before), input.items);
  const items: ProposalItem[] = input.items.map((i) => ({ ...i, anchor: { key: i.anchor.key, version: labelOf(reads.get(i.anchor.key)!.body).version } }));
  const id = newId();
  const { state } = await writeDecided(db, projectId, (s) => {
    check(s, actor, hopId, { messageId: input.messageId, items }); // again, on the state the write sees
    return { type: "proposal.made", projectId, actor, at: now(), data: {
      id, messageId: input.messageId, version: Math.max(...items.map((i) => i.anchor.version)), items,
      // an older OPEN proposal on the same message is superseded in this same event
      supersedes: s.proposals.filter((p) => p.messageId === input.messageId && p.status === "open").map((p) => p.id),
    } };
  });
  return proposalView(state, state.proposals.find((p) => p.id === id)!);
}

/** Newest first. */
export async function listProposals(db: Db, projectId: string, messageId?: string): Promise<Proposal[]> {
  const s = await loadState(db, projectId);
  projectIn(s);
  return s.proposals.filter((p) => messageId === undefined || p.messageId === messageId).sort((a, b) => (a.id < b.id ? 1 : -1)).map((p) => proposalView(s, p));
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
  // the anchors are re-read now (D4): each card is cut at the label and revision Blueprint shows at ACCEPT time, and a key that has left the spec → 422, nothing written
  const reads = await checkAnchors(db, blueprint, projectIn(before), found.items);
  const ids = found.items.map(() => newId());
  const { state } = await writeDecided(db, projectId, (s) => {
    const p = s.proposals.find((x) => x.id === proposalId) ?? (() => { throw notFound("proposal"); })();
    if (p.status !== "open") throw new ApiError(409, "not_open", `that proposal is ${p.status}`);
    // REQ-126 r2 (SPEC-126 D2): only the work not yet on the board becomes cards, judged by anchor key (D1), however the plan is worded or grouped.
    // All of it on the board → 409, nothing written (round 1's identical copy is one case of this).
    const onBoard = new Set(onBoardOf(s, p));
    if (onBoard.size === p.items.length) throw new ApiError(409, "plan_already_accepted", "แผนนี้ตกลงไปแล้ว");
    const fresh = p.items.flatMap((item, i) => (onBoard.has(i) ? [] : [{ item, i }]));
    for (const { item, i } of fresh) {
      if (!s.members.includes(item.workerId)) throw new ApiError(400, "not_a_member", `items[${i}].workerId ${item.workerId} is no longer in this project's chain`);
    }
    // a dependency on an item that is already on the board waits for the live card(s) holding that key instead
    const dependsOn = (item: ProposalItem) => [...new Set(item.dependsOn.flatMap((j) => (onBoard.has(j) ? liveCards(s, p.items[j]!.anchor.key).map((c) => c.id) : [ids[j]!])))];
    const at = now();
    const first = Math.max(0, ...s.cards.map((c) => c.number)) + 1;
    return [
      ...fresh.map(({ item, i }, k) => ({ type: "card.created" as const, projectId, actor, at, data: {
        id: ids[i]!, number: first + k, title: item.title, todo: item.todo, anchor: cardAnchor(item.anchor.key, reads.get(item.anchor.key)!), assigneeId: item.workerId, dependsOn: dependsOn(item),
      } })),
      { type: "proposal.accepted" as const, projectId, actor, at, data: { proposalId, cardIds: fresh.map(({ i }) => ids[i]!) } },
    ];
  });
  const made = state.proposals.find((x) => x.id === proposalId)!.cardIds!;
  return made.map((id) => cardView(state, state.cards.find((c) => c.id === id)!));
}
