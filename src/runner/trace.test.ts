import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateTraces, toolSummary, traceDirFrom, writeTrace } from "./trace";

const tmp = () => mkdtempSync(join(tmpdir(), "trace-test-"));
const asst = (id: string, ...tools: string[]) => JSON.stringify({ type: "assistant", message: { id, content: tools.map((name, i) => ({ type: "tool_use", id: `${id}-${i}`, name, input: {} })) } });

describe("traceDirFrom", () => {
  test("RUNNER_TRACE_DIR wins; blank falls back to ~/.caw/traces", () => {
    expect(traceDirFrom({ RUNNER_TRACE_DIR: "/x/y" })).toBe("/x/y");
    expect(traceDirFrom({ RUNNER_TRACE_DIR: "" })).toMatch(/\.caw\/traces$/);
  });
});

describe("writeTrace", () => {
  test("writes <hopId>.jsonl, 0600 in a 0700 folder, every line redacted", () => {
    const dir = join(tmp(), "traces");
    const path = writeTrace(dir, "hop-1", ['{"a":"git push https://u:secret@h/r"}', '{"b":"Bearer abc123"}']);
    expect(path).toBe(join(dir, "hop-1.jsonl"));
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("abc123");
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toEqual(["hop-1.jsonl"]); // no temp file left behind
  });
  test("a hop id cannot walk out of the folder", () => {
    const dir = tmp();
    const path = writeTrace(dir, "../../etc/x", ["{}"]);
    expect(path.startsWith(dir)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
  test("an empty stream still leaves a file (a hop that said nothing is itself evidence)", () => {
    const dir = tmp();
    expect(existsSync(writeTrace(dir, "h", []))).toBe(true);
  });
});

describe("rotateTraces", () => {
  test("keeps the newest N .jsonl files and leaves other files alone", () => {
    const dir = tmp();
    for (let i = 0; i < 5; i++) {
      const f = join(dir, `h${i}.jsonl`);
      writeFileSync(f, "{}\n");
      utimesSync(f, 1000 + i, 1000 + i);
    }
    writeFileSync(join(dir, "notes.txt"), "keep");
    rotateTraces(dir, 2, () => {});
    expect(readdirSync(dir).sort()).toEqual(["h3.jsonl", "h4.jsonl", "notes.txt"]);
  });
  test("a missing folder is not an error", () => {
    expect(() => rotateTraces(join(tmp(), "nope"), 2, () => {})).not.toThrow();
  });
});

describe("toolSummary", () => {
  test("counts tools by short name, lists expected-but-unused ones as ×0, and counts turns", () => {
    const lines = [asst("m1", "mcp__caw__chat_context"), asst("m2", "mcp__caw__chat_context", "mcp__caw__chat_context"), asst("m3", "Bash")];
    expect(toolSummary(lines, ["locate", "reply"])).toBe("tools: chat_context ×3, Bash ×1, locate ×0, reply ×0 · turns 3");
  });
  test("one assistant message printed on several lines is one turn", () => {
    expect(toolSummary([asst("m1", "mcp__caw__reply"), asst("m1", "mcp__caw__reply")], [])).toBe("tools: reply ×1 · turns 1");
  });
  test("no tools at all", () => {
    expect(toolSummary(["not json", ""], ["reply"])).toBe("tools: reply ×0 · turns 0");
  });
});
