// stream.ts on COPIES of the TASK-C-029 spike fixtures (real `claude` 2.1.287 output). Only the limit case is synthetic, and says so.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { StreamState, summarize } from "./stream";

const lines = (name: string) => readFileSync(new URL(`./fixtures/${name}.stream.jsonl`, import.meta.url).pathname, "utf8").split("\n").filter(Boolean);

describe("summarize on the recorded spike streams", () => {
  test("a plain run: tokens are input + cache creation + cache read, out is output_tokens", () => {
    const s = summarize(lines("ok"));
    expect(s.tokensIn).toBe(10 + 13124 + 22383);
    expect(s.tokensOut).toBe(455);
    expect(s.subtype).toBe("success");
    expect(s.isError).toBe(false);
    expect(s.blocks).toEqual([]);
    expect(s.limit).toBeNull();
  });

  test("git push through RELATIVE hooks was not blocked: no block, and the run still ends success", () => {
    const s = summarize(lines("push-relative-hooks"));
    expect(s.blocks).toEqual([]);
    expect(s.subtype).toBe("success");
  });

  test("git push through ABSOLUTE hooks: one HOOK block, naming the tool and the command", () => {
    const s = summarize(lines("push-absolute-hooks"));
    expect(s.blocks).toHaveLength(1); // result.permission_denials lists the same call; it is not counted twice
    expect(s.blocks[0]!.kind).toBe("hook");
    expect(s.blocks[0]!.tool).toBe("Bash");
    expect(s.blocks[0]!.action).toBe("Bash: git push origin HEAD");
    expect(s.blocks[0]!.text).toStartWith("PreToolUse:Bash hook error:");
    expect(s.subtype).toBe("success"); // a run with a block still ends success
  });

  test("a write outside the roots is one PERMISSION block", () => {
    const s = summarize(lines("write-outside"));
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]!.kind).toBe("permission");
    expect(s.blocks[0]!.tool).toBe("Bash");
    expect(s.blocks[0]!.text).toContain("outside the working directories");
    expect(s.blocks[0]!.action).toStartWith("Bash: mkdir -p ");
  });

  test("the curl fallback after --disallowedTools is one PERMISSION block", () => {
    const s = summarize(lines("no-web"));
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]!.kind).toBe("permission");
    expect(s.blocks[0]!.action).toContain("curl -s https://example.com");
  });
});

describe("StreamState, line by line (what hop.ts feeds it)", () => {
  test("returns the new blocks of THIS line, so the hop can stop at the first one", () => {
    const st = new StreamState();
    const seen = lines("push-absolute-hooks").map((l) => st.feed(l));
    expect(seen.flat()).toHaveLength(1);
    expect(seen.filter((b) => b.length > 0)).toHaveLength(1);
  });

  test("a line that is not JSON is ignored, not thrown on", () => {
    const st = new StreamState();
    expect(st.feed("not json at all")).toEqual([]);
    expect(st.feed("")).toEqual([]);
    expect(st.summary().subtype).toBeNull();
  });

  test("a stream that has neither a result nor an assistant message yet has null tokens, not zero", () => {
    const st = new StreamState();
    for (const l of lines("ok").slice(0, 5)) st.feed(l);
    expect(st.summary().tokensIn).toBeNull();
    expect(st.summary().tokensOut).toBeNull();
  });
});

describe("the subscription limit (SYNTHETIC line — the real 'hit' value was never observed, TASK-C-029 § 4)", () => {
  const evt = (status: string) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status, resetsAt: 1791898200, rateLimitType: "five_hour" } });
  test("any status other than allowed is a limit, with its reset time", () => {
    const st = new StreamState();
    st.feed(evt("allowed"));
    expect(st.summary().limit).toBeNull();
    st.feed(evt("rejected"));
    expect(st.summary().limit).toEqual({ status: "rejected", resetsAt: 1791898200 });
  });
  test("`allowed_warning` (strings found in the CLI binary — inferred, not documented) is NOT a limit: the hop goes on", () => {
    const st = new StreamState();
    st.feed(evt("allowed_warning"));
    expect(st.limit).toBeNull();
  });
  test("`rejected` is a limit, and so is any value nobody has seen yet — the safe side for an unknown", () => {
    for (const status of ["rejected", "something_new"]) {
      const st = new StreamState();
      st.feed(evt(status));
      expect(st.limit).toEqual({ status, resetsAt: 1791898200 });
    }
  });
  test("a recorded 'allowed' event never sets it", () => {
    expect(summarize(lines("ok")).limit).toBeNull();
  });
});

describe("StreamState never throws on valid JSON of an unexpected shape (found by the silent-failure review)", () => {
  test.each([
    ["result with permission_denials as an object", '{"type":"result","permission_denials":{}}'],
    ["result with a null denial", '{"type":"result","permission_denials":[null]}'],
    ["assistant with content as an object", '{"type":"assistant","message":{"content":{"a":1}}}'],
    ["user with content as a string", '{"type":"user","message":{"content":"hi"}}'],
    ["a bare number", "42"],
    ["null", "null"],
  ])("%s", (_name, line) => {
    const st = new StreamState();
    expect(() => st.feed(line)).not.toThrow();
  });

  test("lines that are not JSON are counted, so the runner can say so — not dropped without a trace", () => {
    const st = new StreamState();
    st.feed("Error: something plain on stdout");
    st.feed('{"type":"system"}');
    st.feed("another");
    expect(st.unparsed).toBe(2);
  });

  test("a line that crashes the parser is counted as a fault, and the stream goes on", () => {
    const st = new StreamState();
    st.feed('{"type":"result","permission_denials":{}}');
    expect(st.faults).toBe(1);
    expect(st.feed('{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"t1","message":"no"}')).toHaveLength(1);
  });
});

describe("what the log needs to see about a hop (R-5 trial): the init message and the token breakdown", () => {
  test("init: tools, MCP servers, plugins, model, permission mode, login source", () => {
    const init = summarize(lines("ok")).init!;
    expect(init.tools).toBe(32);
    expect(init.mcpServers).toEqual([]);
    expect(init.plugins.length).toBeGreaterThan(0); // the operator's global plugins load in -p, by default (TASK-C-029)
    expect(init.plugins).toContain("superpowers");
    expect(init.model).toBe("claude-haiku-4-5-20251001");
    expect(init.apiKeySource).toBe("none");
  });
  test("usage keeps the four numbers apart, so the cache part can be compared", () => {
    expect(summarize(lines("ok")).usage).toEqual({ input: 10, cacheCreation: 13124, cacheRead: 22383, output: 455 });
  });
  test("no init / no result yet → null, not zero", () => {
    const st = new StreamState();
    expect(st.summary().init).toBeNull();
    expect(st.summary().usage).toBeNull();
  });
});

describe("tokens of a stream that was cut before its `result` (a stopped hop) — from the assistant messages' own usage (TASK-C-035 item 3)", () => {
  const cut = () => { const all = lines("push-absolute-hooks"); return all.slice(0, all.findIndex((l) => JSON.parse(l).type === "result")); }; // the recorded run, cut before its `result` line
  test("it has no result line, so today's source is empty", () => {
    expect(cut().some((l) => JSON.parse(l).type === "result")).toBe(false);
  });
  test("each DISTINCT message id counts once (one id appears on several lines with the same usage); same in/out formula", () => {
    const s = summarize(cut());
    // msg …DgG: 10 + 9277 + 24115 · msg …XaC: 8 + 595 + 33392 → 67 397, which is exactly what the recorded `result` says for input
    expect(s.tokensIn).toBe(10 + 9277 + 24115 + 8 + 595 + 33392);
    expect(s.tokensIn).toBe(summarize(lines("push-absolute-hooks")).tokensIn);
  });
  test("output is the sum of each message's output_tokens as the assistant line carries it — a LOWER BOUND (1 + 4), the result says 832", () => {
    expect(summarize(cut()).tokensOut).toBe(1 + 4);
    expect(summarize(lines("push-absolute-hooks")).tokensOut).toBe(832);
  });
  test("when a `result` exists it wins over the assistant lines", () => {
    expect(summarize(lines("ok")).tokensIn).toBe(10 + 13124 + 22383);
  });
  test("a stream with no assistant message and no result has null tokens, not zero", () => {
    expect(summarize(lines("ok").slice(0, 5)).tokensIn).toBeNull();
  });
  test("the last usage seen for a message id replaces an earlier one (a streaming snapshot grows)", () => {
    const a = (out: number) => JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: out } } });
    expect(summarize([a(1), a(7)]).tokensOut).toBe(7);
  });
});
