// Following Blueprint (SPEC-A-008 § Following Blueprint, R8). The pull: per CAW project, ask Blueprint's change feed for the
// versions after the newest one we have seen; for each, in order, ONE `card.spec_changed` event flags every card whose anchor
// part changed or was removed in that version and whose anchor is older — the newest version wins, the anchor is never edited —
// and moves latestSeenVersion. It runs on start, every CAW_POLL_MS, and at once when Blueprint pushes /v1/notify.
// Blueprint unreachable → one codes-only log line and the next tick tries again. Pulls run one at a time, so a tick and a
// notice at the same moment cannot both write the same version.
import { eq } from "drizzle-orm";
import { BlueprintUnreachable, type Blueprint } from "../blueprint/client";
import { now } from "../core/ids";
import { loadState } from "../core/state";
import { writeDecided } from "../core/write";
import type { Db } from "../db/client";
import { followState, projects } from "../db/schema";

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
    const after = Math.max(seen?.lastPulledVersion ?? 0, project.latestSeenVersion);
    let feed;
    try {
      feed = await blueprint.versionsAfter(project.blueprintProjectId, after);
    } catch (e) {
      if (e instanceof BlueprintUnreachable) return void log("[pull] blueprint_unreachable");
      throw e;
    }
    let last = after;
    for (const v of feed.versions) {
      const changed = new Set([...v.changes.changed, ...v.changes.removed]);
      await writeDecided(db, projectId, (s) => ({
        type: "card.spec_changed", projectId, actor: "system:pull", at: now(),
        data: { version: v.version, cardIds: s.cards.filter((c) => changed.has(c.anchorKey) && c.anchorVersion < v.version).map((c) => c.id) },
      }));
      last = v.version;
    }
    const row = { projectId, lastPulledVersion: last, lastPullAt: new Date() };
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
