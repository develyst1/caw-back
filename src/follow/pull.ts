// Following Blueprint (SPEC-A-008 § Following Blueprint, R8; REQ-105 / SPEC-107 D6). The pull: per CAW project, ask Blueprint's change feed
// (`/spec/changes?after=<revision>`) for the change sets after the revision we have got to, again while `more`; ONE `spec.revised` event
// per pull flags every card whose anchor part changed or was removed in a set NEWER than the card's anchor revision (the newest set wins,
// the anchor is never edited) and takes the latest label; a card whose anchor part a set REMOVED (or brought back) gets card.anchor_removed (card.anchor_restored). A pull that flags no card and sees no new label writes no event — an interview
// round must not flood the log; it only moves follow_state. It runs on start, every CAW_POLL_MS, and at once when Blueprint pushes /v1/notify.
// Blueprint unreachable → follow_state.last_pull_ok = false, one codes-only log line, and the next tick catches up from the last revision.
// Pulls run one at a time, so a tick and a notice at the same moment cannot both write the same revision.
import { eq } from "drizzle-orm";
import { BlueprintUnreachable, type Blueprint, type SpecChange, type SpecChanges } from "../blueprint/client";
import type { CawEvent } from "../core/events";
import { now } from "../core/ids";
import { loadState } from "../core/state";
import { writeDecided } from "../core/write";
import type { Db } from "../db/client";
import { followState, projects } from "../db/schema";

/** rolls the (empty) write back: a pull that flagged no card and saw no new label writes no event */
class NothingToWrite extends Error {}

export type Follower = {
  pullAll(): Promise<void>;
  /** every CAW project made from this Blueprint project */
  pullFor(blueprintProjectId: string): Promise<void>;
  /** resolves when every pull started so far has finished (tests; a clean stop) */
  idle(): Promise<void>;
  /** pull now, then every `pollMs` (0 = once, no timer); returns the stop function */
  start(pollMs: number): () => void;
};

export function createFollower(db: Db, blueprint: Blueprint, log: (line: string) => void = console.error): Follower {
  let tail: Promise<void> = Promise.resolve();
  const pending = new Set<Promise<void>>();
  // one at a time; a failure is logged (name and code only) and never rejects — the caller is a timer or an HTTP handler
  const queue = (job: () => Promise<void>): Promise<void> => {
    const run = tail.then(job).catch((e: Error) => {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      log(`[pull] error ${e.name}${code ? ` code=${code}` : ""}`);
    });
    tail = run;
    pending.add(run);
    void run.finally(() => pending.delete(run));
    return run;
  };

  async function pullProject(projectId: string): Promise<void> {
    const { project } = await loadState(db, projectId);
    if (!project) return;
    const [seen] = await db.select().from(followState).where(eq(followState.projectId, projectId));
    let after = seen?.lastPulledRevision ?? 0;
    const sets: SpecChange[] = [];
    let latestLabel: SpecChanges["latestLabel"] = null;
    try {
      for (;;) {
        const page = await blueprint.specChanges(project.blueprintProjectId, after);
        // a body that is not a change feed is not an answer: same as unreachable, nothing is moved
        if (!Array.isArray(page.changes)) throw new BlueprintUnreachable("not a change feed");
        sets.push(...page.changes);
        latestLabel = page.latestLabel ?? null;
        const lastRev = page.changes.at(-1)?.rev;
        if (!page.more || lastRev === undefined || lastRev <= after) break; // `more` with nothing new would loop for ever
        after = lastRev;
      }
    } catch (e) {
      if (!(e instanceof BlueprintUnreachable)) throw e;
      const row = { projectId, lastPulledVersion: project.latestSeenVersion, lastPullOk: false };
      await db.insert(followState).values(row).onConflictDoUpdate({ target: followState.projectId, set: { lastPullOk: false } }); // lastPulledRevision and lastPullAt stay: the next pull starts there
      return void log("[pull] blueprint_unreachable");
    }
    const revision = sets.at(-1)?.rev ?? seen?.lastPulledRevision ?? 0;
    const sameLabel = (latestLabel?.version ?? 0) === (project.latestLabel?.version ?? 0) && (latestLabel?.label ?? null) === (project.latestLabel?.label ?? null);
    const label = latestLabel ? { version: latestLabel.version, label: latestLabel.label } : null;
    // decided on the state the write sees (the cards a tick and an operator's clear could have changed in between)
    const ordered = [...sets].sort((x, y) => x.rev - y.rev);
    // D12: per part key, the LAST set that removed it or (re-)added it says whether it is in the spec now (a set that lists a key in both replaced it: it is there)
    const last = new Map<string, { rev: number; removed: boolean }>();
    for (const v of ordered) {
      for (const k of v.removed) last.set(k, { rev: v.rev, removed: true });
      for (const k of v.added) last.set(k, { rev: v.rev, removed: false });
    }
    try {
      await writeDecided(db, projectId, (s) => {
        const out: CawEvent[] = [];
        const cardIds = s.cards.filter((c) => ordered.some((v) => (v.changed.includes(c.anchorKey) || v.removed.includes(c.anchorKey)) && c.anchorRevision < v.rev)).map((c) => c.id);
        if (cardIds.length > 0 || !sameLabel) out.push({ type: "spec.revised", projectId, actor: "system:pull", at: now(), data: { revision, latestLabel: label, cardIds } });
        // one event per (kind, revision): the cards whose part just left the spec / just came back, by the set that did it
        const gone = new Map<number, string[]>();
        const back = new Map<number, string[]>();
        for (const c of s.cards) {
          const l = last.get(c.anchorKey);
          if (!l) continue;
          const into = l.removed ? (c.anchorRemovedRevision === null && c.anchorRevision < l.rev ? gone : null) : (c.anchorRemovedRevision !== null ? back : null);
          if (into) into.set(l.rev, [...(into.get(l.rev) ?? []), c.id]);
        }
        for (const [rev, ids] of [...gone].sort((x, y) => x[0] - y[0])) out.push({ type: "card.anchor_removed", projectId, actor: "system:pull", at: now(), data: { cardIds: ids, revision: rev } });
        for (const [rev, ids] of [...back].sort((x, y) => x[0] - y[0])) out.push({ type: "card.anchor_restored", projectId, actor: "system:pull", at: now(), data: { cardIds: ids, revision: rev } });
        if (out.length === 0) throw new NothingToWrite();
        return out;
      });
    } catch (e) {
      if (!(e instanceof NothingToWrite)) throw e;
    }
    const row = { projectId, lastPulledVersion: label?.version ?? 0, lastPullAt: new Date(), lastPulledRevision: revision, lastPullOk: true };
    await db.insert(followState).values(row).onConflictDoUpdate({ target: followState.projectId, set: row });
  }

  const pullIds = async (ids: string[]) => { for (const id of ids) await pullProject(id); };
  const pullAll = () => queue(async () => pullIds((await db.select({ id: projects.id }).from(projects)).map((p) => p.id)));
  const pullFor = (bp: string) => queue(async () => pullIds((await db.select({ id: projects.id }).from(projects).where(eq(projects.blueprintProjectId, bp))).map((p) => p.id)));

  return {
    pullAll, pullFor,
    async idle() { while (pending.size) await Promise.all([...pending]); },
    start(pollMs) {
      void pullAll();
      if (!(pollMs > 0)) return () => {};
      const timer = setInterval(() => void pullAll(), pollMs);
      return () => clearInterval(timer);
    },
  };
}
