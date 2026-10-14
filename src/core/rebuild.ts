// Rebuild = replay a project's events from empty through the same reducer (AC-6). Worker events have no project
// (`projectId` null) and belong to every project, so they are replayed too — in seq order with the project's own.
import { asc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { events } from "../db/schema";
import { EVENT_TYPES, type CawEvent } from "./events";
import { canonical, empty, reduce, type State } from "./reduce";
import { stable } from "./stable";
import { loadState } from "./state";

// The types a reducer branch exists for (the others are reserved names — see events.ts).
const HANDLED = new Set<string>([
  "project.created", "worker.created", "worker.combined", "chain.member_added", "chain.member_removed", "chain.edge_added", "chain.edge_removed",
  "chain.entry_set", "card.created", "card.status_set", "card.assigned", "card.handed_off", "card.commented", "card.question_opened",
  "card.question_answered", "card.spec_change_cleared", "card.handoff_refused", "card.spec_changed", "project.mode_set", "project.workspace_set",
  "run.started", "run.finished", "hop.started", "hop.claimed", "hop.finished",
  "chat.posted", "chat.replied", "hop.located", "proposal.made", "proposal.accepted", "chat.retry_requested", "worker.updated", "hop.heartbeat",
] satisfies (typeof EVENT_TYPES)[number][]);

export async function rebuild(db: Db, projectId: string, each?: (event: CawEvent) => void): Promise<State> {
  const rows = await db.select().from(events).where(or(eq(events.projectId, projectId), isNull(events.projectId))).orderBy(asc(events.seq));
  let state = empty;
  for (const r of rows) {
    const event = { projectId: r.projectId, type: r.type, actor: r.actor, at: r.at.toISOString(), data: r.data } as CawEvent;
    each?.(event);
    if (HANDLED.has(event.type)) state = reduce(state, event);
  }
  return state;
}

/** Compares what the tables hold with a rebuild from the events; writes nothing. */
export async function rebuildCheck(db: Db, projectId: string): Promise<{ same: boolean; diff?: { tables: State; rebuilt: State } }> {
  const tables = canonical(await loadState(db, projectId));
  const rebuilt = canonical(await rebuild(db, projectId));
  return stable(tables) === stable(rebuilt) ? { same: true } : { same: false, diff: { tables, rebuilt } };
}
