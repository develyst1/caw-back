// What the runner learns from a project's event log, folded in incrementally (the cursor is the last seq seen). Derived data: after a restart
// it is rebuilt from seq 0, so the runner still holds nothing the store does not.
import type { ApiEvent } from "./api";

export class ProjectWatch {
  cursor = 0;
  /** seq of the newest `project.mode_set → dispatcher` */
  modeSetSeq = 0;
  runStartSeq = new Map<string, number>();
  runEndSeq = new Map<string, number>();
  private status = new Map<string, string>(); // a card's status, replayed from its own events (a new card is `todo`)
  private sentBack = new Map<string, number[]>(); // card → seqs of review → todo|doing

  fold(events: ApiEvent[]): void {
    for (const e of events) {
      if (e.seq <= this.cursor) continue; // already folded: two readers may race on one cursor, and a replay must not count a send-back twice
      if (e.type === "project.mode_set" && e.data?.mode === "dispatcher") this.modeSetSeq = e.seq;
      else if (e.type === "run.started") this.runStartSeq.set(String(e.data?.id), e.seq);
      else if (e.type === "run.finished") this.runEndSeq.set(String(e.data?.runId), e.seq);
      else if (e.type === "card.created") this.status.set(String(e.data?.id), "todo");
      else if (e.type === "card.status_set") {
        const id = String(e.data?.cardId);
        const was = this.status.get(id) ?? "todo";
        const now = String(e.data?.status);
        // The contract has no "rework" status: a card sent back from review to todo or doing is the review failing (Interpreted).
        if (was === "review" && (now === "todo" || now === "doing")) this.sentBack.set(id, [...(this.sentBack.get(id) ?? []), e.seq]);
        this.status.set(id, now);
      }
      this.cursor = e.seq;
    }
  }

  /** May a new run open? Only if the operator switched to dispatcher AFTER this run ended. No `run.finished` seen → no, never guess. */
  switchedSince(runId: string): boolean {
    const ended = this.runEndSeq.get(runId);
    return ended !== undefined && this.modeSetSeq > ended;
  }

  /** A card sent back from review at least twice during this run: its id. Send-backs of earlier runs do not count. */
  reviewFailedIn(runId: string): string | null {
    const start = this.runStartSeq.get(runId);
    if (start === undefined) return null;
    for (const [card, seqs] of this.sentBack) if (seqs.filter((s) => s > start).length >= 2) return card; // twice DURING this run
    return null;
  }
}
