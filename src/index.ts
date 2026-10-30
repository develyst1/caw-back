import { createApp } from "./app";
import { createBlueprint } from "./blueprint/client";
import { createDb } from "./db/client";
import { createFollower } from "./follow/pull";

// Never print the URL itself — it may hold a password.
const url = process.env.DATABASE_URL ?? "";
if (!url) {
  console.error("DATABASE_URL is not set (use pglite:memory for local)");
  process.exit(1);
}

const db = await createDb(url);
const blueprint = createBlueprint();
const follow = createFollower(db, blueprint);
const app = createApp(db, { blueprint, follow });
// `||`, not `??`: Bun loads `.env` itself, and an empty `PORT=` there arrives as "".
// This machine only unless HOST says otherwise: v1 has no login (SPEC-A-008 R-1).
const server = Bun.serve({ hostname: process.env.HOST || "127.0.0.1", port: Number(process.env.PORT || 4500), fetch: app.fetch });
// One line when it is really serving, so `bun run dev` (src/dev.ts) shows an `[api]` line. The address only — never the database URL (it may hold a password).
console.log(`caw-back API on http://${server.hostname}:${server.port}`);
// Follow Blueprint: pull now (a notice missed while we were down is found here), then every CAW_POLL_MS (default 10 s — REQ-105 AC-1 wants an edit seen within 30 s even if Blueprint's push is missed, and a 30 s tick plus a pull would be over it; 0 = no timer).
const poll = process.env.CAW_POLL_MS === undefined || process.env.CAW_POLL_MS === "" ? 10_000 : Number(process.env.CAW_POLL_MS);
follow.start(Number.isFinite(poll) && poll >= 0 ? poll : 10_000);
