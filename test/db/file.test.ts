// `pglite:file:<dir>` — a PGlite database kept in a directory, so a local check can stop and restart caw-back and still
// find its data (the AC-8 "stopped during the confirm" check). `pglite:memory` and a Postgres URL are as before.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvent } from "../../src/core/write";
import { loadState } from "../../src/core/state";
import { createDb } from "../../src/db/client";

test("a file-backed PGlite keeps its rows across a close and a re-open (migrations applied once)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-pglite-"));
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    const db = await createDb(`pglite:file:${dir}`);
    await writeEvent(db, { type: "project.created", projectId: id, actor: "operator", at: "2026-10-13T08:00:00.000Z", data: { id, name: "เก็บไว้", blueprintProjectId: "bp", version: 1 } });
    await (db as unknown as { $client: { close(): Promise<void> } }).$client.close();
    const again = await createDb(`pglite:file:${dir}`);
    expect((await loadState(again, id)).project?.name).toBe("เก็บไว้");
    await (again as unknown as { $client: { close(): Promise<void> } }).$client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
