// `.env.example` is COMMITTED: it lists every key and holds no value. The real `.env` is git-ignored and the operator's — this test
// never opens it. And the `runner` script points at Team C's entry (TASK-A-077).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

test(".env.example: the eleven keys, every value empty, a comment line above each key, nothing that looks like a secret", () => {
  const lines = read(".env.example").split("\n");
  const keys = lines.filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
  expect(keys).toEqual(["DATABASE_URL=", "PORT=", "BLUEPRINT_URL=", "CAW_POLL_MS=", "CAW_WORKSPACE_ROOT=", "BLUEPRINT_WEB_URL=", "CAW_API_URL=", "RUNNER_POLL_MS=", "RUNNER_HOP_MAX_MS=", "CLAUDE_BIN=", "RUNNER_TRACE_DIR="]);
  for (const k of keys) {
    const above = lines[lines.indexOf(k) - 1] ?? "";
    expect([k, above.startsWith("# ")]).toEqual([k, true]);
  }
  expect(lines.filter((l) => /=.+/.test(l))).toEqual([]); // no value anywhere, comments included
  expect(read(".env.example")).not.toMatch(/postgres(ql)?:\/\/|password|secret/i);
});

test("package.json: the `runner` script runs Team C's entry src/runner/main.ts", () => {
  expect((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts.runner).toBe("bun run src/runner/main.ts");
});
