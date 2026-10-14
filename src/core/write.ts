// The one write path (SPEC-A-008 § Design): in ONE transaction — lock the project, load its state, let the caller DECIDE
// on that state (it validates and builds the event; a refusal throws and nothing was written), run the reducer, insert the
// event, save what the reducer changed. If the tables refuse the result, the event goes with it.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { events } from "../db/schema";
import type { CawEvent } from "./events";
import { reduce, type State } from "./reduce";
import { loadState } from "./state";
import { saveState } from "./state";

/** `projectId` null = a worker-level write. One lock per project (and one for workers), so decisions see current state.
 *  `decide` may return several events (accepting a proposal = n cards + the acceptance): they are inserted and reduced in order,
 *  in this one transaction. */
export async function writeDecided(db: Db, projectId: string | null, decide: (state: State) => CawEvent | CawEvent[]): Promise<{ seq: number; state: State; event: CawEvent }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${projectId ?? "workers"}))`);
    const before = await loadState(tx, projectId);
    const decided = decide(before);
    const list = Array.isArray(decided) ? decided : [decided];
    let after = before;
    let seq = 0;
    for (const event of list) {
      after = reduce(after, event);
      const [row] = await tx.insert(events).values({
        projectId: event.projectId, type: event.type, actor: event.actor, at: new Date(event.at), data: event.data,
      }).returning({ seq: events.seq });
      seq = row!.seq;
    }
    await saveState(tx, before, after);
    return { seq, state: after, event: list.at(-1)! };
  });
}

export const writeEvent = (db: Db, event: CawEvent) => writeDecided(db, event.projectId, () => event);
