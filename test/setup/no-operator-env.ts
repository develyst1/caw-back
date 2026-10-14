// TASK-A-083 Q2: `bun test` loads the operator's git-ignored `.env` before any test runs (it also carries DATABASE_URL = SIT), and a test
// that reads process.env would then depend on a private file. This preload (bunfig.toml) clears every key `.env.example` lists, so a test
// sees what a fresh clone sees. The names come from `.env.example` — never a second list — and `.env` itself is never opened here.
// A test that sets a key itself keeps working: it sets it after this runs.
import { readFileSync } from "node:fs";

const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
for (const line of example.split("\n")) {
  const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
  if (key !== undefined) delete process.env[key];
}
