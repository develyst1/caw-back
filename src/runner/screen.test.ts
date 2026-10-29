// REQ-104 / SPEC-103 § The runner: what a worker's screen shows. Pure parts first (screenLines, liveRedact, secretValues), then the sender with a fake clock,
// a fake `post` and a hand-driven flush. No real claude, no network.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ScreenEntry, createScreenSender, liveRedact, screenLines, secretValues } from "./screen";

const FIXTURES = join(import.meta.dir, "fixtures");
const streamLines = (f: string) => readFileSync(join(FIXTURES, f), "utf8").split("\n").filter((l) => l !== "");
const J = (o: object) => JSON.stringify(o);
const assistant = (...content: object[]) => J({ type: "assistant", message: { role: "assistant", content } });

describe("screenLines", () => {
  test("every recorded fixture renders to plain text lines: strings, none over 2000 chars, never raw JSON; session first, a result last when there is one", () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".stream.jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const out = streamLines(f).flatMap(screenLines);
      for (const l of out) {
        expect([f, typeof l]).toEqual([f, "string"]);
        expect(l.length).toBeLessThanOrEqual(2000);
        expect([f, l.startsWith("{")]).toEqual([f, false]);
      }
      if (streamLines(f).some((l) => l.includes('"subtype":"init"'))) expect([f, out[0]!.startsWith("● session ")]).toEqual([f, true]);
      if (streamLines(f).some((l) => l.includes('"type":"result"'))) expect([f, out[out.length - 1]!.startsWith("■ ")]).toEqual([f, true]);
    }
  });

  test("ok.stream.jsonl renders to the session line, the worker's words split on new lines, and the result", () => {
    const out = streamLines("ok.stream.jsonl").flatMap(screenLines);
    expect(out[0]).toBe("● session claude-haiku-4-5-20251001");
    expect(out[1]).toBe("ตกลง (OK) ✓");
    expect(out).toContain("- จะพูดภาษาไทยกับคุณ แต่เก็บโค้ดเป็นภาษาอังกฤษ");
    expect(out[out.length - 1]).toBe("■ success · turns 1");
  });

  test("a tool call: the tool name without mcp__caw__, then the Bash command, the file_path of Read / Edit / Write, or compact JSON", () => {
    expect(screenLines(assistant({ type: "tool_use", name: "Bash", input: { command: "bun test\n  --bail", description: "run" } }))).toEqual(["▸ Bash bun test --bail"]);
    for (const t of ["Read", "Edit", "Write"]) expect(screenLines(assistant({ type: "tool_use", name: t, input: { file_path: "/a/b.ts", old_string: "x" } }))).toEqual([`▸ ${t} /a/b.ts`]);
    expect(screenLines(assistant({ type: "tool_use", name: "mcp__caw__comment", input: { cardId: "c1", text: "hi" } }))).toEqual(['▸ comment {"cardId":"c1","text":"hi"}']);
    expect(screenLines(assistant({ type: "tool_use", name: "Grep", input: { pattern: "x".repeat(500) } }))[0]!.length).toBe("▸ Grep ".length + 200); // summary ≤ 200
  });

  test("an erroring tool result → ✗ and its first 200 chars; a good result shows nothing", () => {
    const bad = J({ type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true, content: `nope ${"y".repeat(300)}` }] } });
    const r = screenLines(bad);
    expect(r).toHaveLength(1);
    expect(r[0]!.startsWith("✗ nope yyy")).toBe(true);
    expect(r[0]!.length).toBe(2 + 200);
    const asBlocks = J({ type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "blocked" }] }] } });
    expect(screenLines(asBlocks)).toEqual(["✗ blocked"]);
    expect(screenLines(J({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "fine" }] } }))).toEqual([]);
  });

  test("anything else, or not JSON, or an unknown type → nothing, and it never throws", () => {
    for (const l of ["", "not json", "null", "42", '"str"', "[]", "{", J({ type: "rate_limit_event" }), J({ type: "system", subtype: "hook_started" }), J({ type: "assistant", message: null }),
      J({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "text" }, null, 3] } }), J({ type: "something_new_in_cli_3" })]) {
      expect([l, screenLines(l)]).toEqual([l, []]);
    }
  });

  test("every line is cut to 2000 chars; blank text shows nothing", () => {
    expect(screenLines(assistant({ type: "text", text: "z".repeat(5000) }))[0]!.length).toBe(2000);
    expect(screenLines(assistant({ type: "text", text: "  \n " }))).toEqual([]);
    expect(screenLines(assistant({ type: "text", text: "one\r\ntwo\n\nfour\n\n" }))).toEqual(["one", "two", "", "four"]);
  });
});

describe("liveRedact", () => {
  const SHAPES: [string, string][] = [
    ["sk-", "sk-test-abcdefghijklmnopqrstuvwx"],
    ["ghp_", `ghp_${"a1".repeat(18)}`],
    ["gho_", `gho_${"B".repeat(30)}`],
    ["github_pat_", `github_pat_${"Z9_".repeat(12)}`],
    ["AKIA", "AKIAABCDEFGHIJKLMNOP"],
    ["xox", "xoxb-1234567890-abcdefghij"],
    ["AIza", `AIza${"q".repeat(35)}`],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij_-12345"],
  ];
  for (const [name, key] of SHAPES) {
    test(`a bare ${name} key becomes *** wherever it stands (no secrets list needed)`, () => {
      expect(liveRedact(`use ${key} now`, [])).toBe("use *** now");
      expect(liveRedact(key, [])).toBe("***");
      expect(liveRedact(`x=${key};y`, []).includes(key)).toBe(false);
    });
  }

  test("a known value becomes *** — exactly, every occurrence, longest first", () => {
    expect(liveRedact("password is s3cr3t-value-123 ok", ["s3cr3t-value-123"])).toBe("password is *** ok");
    expect(liveRedact("a s3cr3t-value-123 b s3cr3t-value-123", ["s3cr3t-value-123"])).toBe("a *** b ***");
    expect(liveRedact("abcdef-longer and abcdef", ["abcdef", "abcdef-longer"])).toBe("*** and ***");
    expect(liveRedact("S3CR3T-VALUE-123", ["s3cr3t-value-123"])).toBe("S3CR3T-VALUE-123"); // exact match, not case-folded
    expect(liveRedact("regex (chars) [in] a.b*c", ["a.b*c"])).toBe("regex (chars) [in] ***"); // a value is text, not a pattern
    expect(liveRedact("nothing here", ["", "x".repeat(0)])).toBe("nothing here"); // an empty value never matches everything
  });

  test("redact()'s own forms still apply: URL credentials, token= / key= / password=, Bearer", () => {
    expect(liveRedact("git push https://user:hunter2@host/x", [])).toBe("git push https://***@host/x");
    expect(liveRedact("API_TOKEN=abc123 password=hunter2", [])).toBe("API_TOKEN=*** password=***");
    expect(liveRedact("Authorization: Bearer abc.def.ghi", [])).toBe("Authorization: Bearer ***");
  });

  test('"monkey=banana" stays, and so do ordinary words, Thai text and short hex-like strings', () => {
    for (const t of ["monkey=banana", "sky-high plans", "ask-me-anything", "ฉันจะสร้างไฟล์", "commit 1a2b3c4d5e6f", "AKIA is a prefix", "eyJ is not enough"]) expect([t, liveRedact(t, [])]).toEqual([t, t]);
  });
});

describe("secretValues", () => {
  const env = {
    DATABASE_URL: "postgres://u:p@h/db", MY_API_KEY: "abcdefg", GH_TOKEN: "tok-1234", DB_PASS: "pass99", BLUEPRINT_URL: "http://127.0.0.1:4200",
    CAW_WORKSPACE_ROOT: "/ws/root", PORT: "4500", SHORT_TOKEN: "abc", HOME: "/home/x", EMPTY_SECRET: "", FIVE_KEY: "12345", PATH: "/usr/bin:/bin",
  };
  test("the value of every key whose NAME says secret (KEY / TOKEN / SECRET / PASSWORD / PASS / DATABASE_URL, any case), when it is at least 6 characters — nothing else", () => {
    const got = secretValues(env);
    expect(got.sort()).toEqual(["abcdefg", "pass99", "postgres://u:p@h/db", "tok-1234"].sort());
    expect(got).not.toContain("/ws/root"); // CAW_WORKSPACE_ROOT is a path, not a secret: it stays readable on the screen
    expect(got).not.toContain("http://127.0.0.1:4200"); // BLUEPRINT_URL: a plain URL
    expect(got).not.toContain("4500"); // PORT
    expect(got).not.toContain("/home/x"); // HOME
    expect(got).not.toContain("abc"); // a secret name, under 6
    expect(got).not.toContain("12345"); // 5 chars
    expect(secretValues({ my_api_key: "lowercase-name-ok" })).toEqual(["lowercase-name-ok"]);
  });
  test("two keys with one value give it once; with no env, nothing; a path in CAW_WORKSPACE_ROOT is left alone by liveRedact", () => {
    expect(secretValues({ A_SECRET: "samevalue", B_TOKEN: "samevalue" })).toEqual(["samevalue"]);
    expect(secretValues({})).toEqual([]);
    expect(liveRedact("▸ Read /home/x/ws/src/a.ts", secretValues({ CAW_WORKSPACE_ROOT: "/home/x/ws", CLAUDE_BIN: "/home/x/.local/bin/claude" }))).toBe("▸ Read /home/x/ws/src/a.ts");
  });
});

// ---------- the sender ----------
function rig(over: Partial<Parameters<typeof createScreenSender>[0]> = {}) {
  const r = {
    t: Date.parse("2026-10-29T10:00:00.000Z"), posts: [] as ScreenEntry[][], logs: [] as string[], fail: false, stopped: false, tick: () => {},
    sender: undefined as unknown as ReturnType<typeof createScreenSender>,
  };
  r.sender = createScreenSender({
    post: async (hopId, entries) => { expect(hopId).toBe("hop-1"); r.posts.push(entries); if (r.fail) throw new Error("API down"); },
    hopId: "hop-1", now: () => new Date(r.t), log: (l) => r.logs.push(l),
    every: (fn) => { r.tick = fn; return () => { r.stopped = true; }; },
    ...over,
  });
  /** one flush, then let the request settle */
  const flush = async () => { r.tick(); await new Promise((res) => setTimeout(res, 5)); };
  return { ...r, r, flush, push: (...texts: string[]) => texts.forEach((x) => r.sender.push(x)) };
}

describe("createScreenSender", () => {
  test("push never waits: nothing is sent until the flush; a flush sends the queue in order with the time each line was seen and increasing seq", async () => {
    const k = rig();
    k.push("a", "b", "c");
    expect(k.r.posts).toEqual([]);
    k.r.t += 1000; // the flush comes later; `at` is when the line was SEEN
    await k.flush();
    expect(k.r.posts).toEqual([[
      { seq: 0, at: "2026-10-29T10:00:00.000Z", kind: "line", text: "a" },
      { seq: 1, at: "2026-10-29T10:00:00.000Z", kind: "line", text: "b" },
      { seq: 2, at: "2026-10-29T10:00:00.000Z", kind: "line", text: "c" },
    ]]);
    await k.flush();
    expect(k.r.posts).toHaveLength(1); // an empty queue sends nothing
  });

  test("batches are at most 200: 450 lines go out as 200 + 200 + 50, one per flush, seq 0…449 in order", async () => {
    const k = rig();
    for (let i = 0; i < 450; i++) k.r.sender.push(`l${i}`);
    for (let i = 0; i < 4; i++) await k.flush();
    expect(k.r.posts.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(k.r.posts.flat().map((e) => e.seq)).toEqual(Array.from({ length: 450 }, (_, i) => i));
  });

  test("one request in flight at most: a flush while the last request is unanswered sends nothing", async () => {
    let release!: () => void;
    const k = rig({ post: (_h, entries) => new Promise<void>((res) => { posts.push(entries); release = res; }) });
    const posts: ScreenEntry[][] = [];
    k.push("a");
    k.r.tick(); k.r.tick();
    k.push("b");
    k.r.tick();
    await new Promise((res) => setTimeout(res, 5));
    expect(posts).toHaveLength(1);
    release();
    await new Promise((res) => setTimeout(res, 5));
    await k.flush();
    expect(posts.map((b) => b.map((e) => e.text))).toEqual([["a"], ["b"]]);
  });

  test("API down: the failed batch and the queue are dropped, lines pushed while down are dropped, each flush sends one gap probe with the seconds since the first failure; the first probe that works ends it and new lines flow", async () => {
    const k = rig();
    k.push("a", "b", "c"); // seq 0-2
    k.r.fail = true;
    k.r.t += 1000;
    await k.flush(); // the batch fails: down since t0
    expect(k.r.posts).toHaveLength(1);
    expect(k.r.logs.filter((l) => l.includes("not sent"))).toHaveLength(1);
    k.push("d"); // seq 3 — dropped, a hole
    k.r.t += 12_500;
    await k.flush(); // probe 1 (seq 4), fails
    expect(k.r.posts[1]).toEqual([{ seq: 4, at: new Date(k.r.t).toISOString(), kind: "gap", text: "", gapSeconds: 13 }]);
    k.push("e"); // seq 5 — dropped
    k.r.t += 17_500; // 30 s since the first failure
    k.r.fail = false;
    await k.flush(); // probe 2 (seq 6) works
    expect(k.r.posts[2]).toEqual([{ seq: 6, at: new Date(k.r.t).toISOString(), kind: "gap", text: "", gapSeconds: 30 }]);
    expect(k.r.logs.some((l) => l.includes("flowing again after 30 s"))).toBe(true);
    k.push("f"); // seq 7
    await k.flush();
    expect(k.r.posts[3]!.map((e) => [e.seq, e.kind, e.text])).toEqual([[7, "line", "f"]]);
    expect(k.r.posts).toHaveLength(4); // no stray requests: only the batch, two probes and the recovery batch
  });

  test("a gap is never under 1 second", async () => {
    const k = rig();
    k.push("a");
    k.r.fail = true;
    await k.flush();
    k.r.fail = false;
    await k.flush(); // same millisecond
    expect(k.r.posts[1]![0]).toMatchObject({ kind: "gap", gapSeconds: 1 });
  });

  test("after maxLines lines: one truncated entry, then every further line is dropped", async () => {
    const k = rig({ maxLines: 3 });
    k.push("1", "2", "3", "4", "5", "6");
    await k.flush();
    expect(k.r.posts[0]!.map((e) => [e.seq, e.kind, e.text])).toEqual([[0, "line", "1"], [1, "line", "2"], [2, "line", "3"], [3, "truncated", ""]]);
    k.push("7", "8");
    await k.flush();
    expect(k.r.posts).toHaveLength(1);
  });

  test("the cut-off point reached while the API is down is still said, once it is back", async () => {
    const k = rig({ maxLines: 2 });
    k.push("1");
    k.r.fail = true;
    await k.flush(); // down
    k.push("2", "3", "4"); // 3 and 4 are past the cap; down, so nothing can be queued
    k.r.t += 5000;
    k.r.fail = false;
    await k.flush(); // the probe works → the truncated entry is queued
    await k.flush();
    expect(k.r.posts.at(-1)!.map((e) => e.kind)).toEqual(["truncated"]);
    k.push("5");
    await k.flush();
    expect(k.r.posts.flat().filter((e) => e.kind === "truncated")).toHaveLength(1);
  });

  test("a request that never answers counts as failed after postTimeoutMs", async () => {
    const k = rig({ post: () => new Promise(() => {}), postTimeoutMs: 20 });
    k.push("a");
    k.r.tick();
    await new Promise((res) => setTimeout(res, 60));
    expect(k.r.logs.some((l) => l.includes("no answer in 20 ms"))).toBe(true);
  });

  test("close() sends what is queued without waiting for the next flush, stops the timer, and later pushes do nothing", async () => {
    const k = rig();
    k.push("a", "b");
    await k.r.sender.close();
    expect(k.r.stopped).toBe(true);
    expect(k.r.posts.flat().map((e) => e.text)).toEqual(["a", "b"]);
    k.push("c");
    await k.r.sender.close(); // twice is fine
    expect(k.r.posts).toHaveLength(1);
  });

  test("close() with the API down sends nothing more and returns at once; with a request that never answers it returns within closeMs", async () => {
    const down = rig();
    down.push("a");
    down.r.fail = true;
    await down.flush();
    const t0 = Date.now();
    await down.r.sender.close();
    expect(Date.now() - t0).toBeLessThan(500);

    const hung = rig({ post: () => new Promise(() => {}), closeMs: 80, postTimeoutMs: 10_000 });
    hung.push("a");
    const t1 = Date.now();
    await hung.r.sender.close();
    const took = Date.now() - t1;
    expect(took).toBeGreaterThanOrEqual(70);
    expect(took).toBeLessThan(1000);
  });

  test("push and close never throw — not when the clock throws, nor when post throws synchronously or rejects", async () => {
    const clock = rig({ now: () => { throw new Error("clock"); } });
    expect(() => clock.push("a")).not.toThrow();
    await expect(clock.r.sender.close()).resolves.toBeUndefined();
    expect(clock.r.logs.some((l) => l.includes("screen push failed: clock"))).toBe(true);

    const sync = rig({ post: () => { throw new Error("sync boom"); } });
    sync.push("a");
    await sync.flush();
    await expect(sync.r.sender.close()).resolves.toBeUndefined();
    expect(sync.r.logs.some((l) => l.includes("sync boom"))).toBe(true);

    const rej = rig({ post: () => Promise.reject(new Error("rejected")) });
    rej.push("a");
    await rej.flush();
    await expect(rej.r.sender.close()).resolves.toBeUndefined();
  });

  test("a line over 2000 chars is cut; the failure is logged once per streak, not once per flush", async () => {
    const k = rig();
    k.push("y".repeat(3000));
    k.r.fail = true;
    await k.flush();
    for (let i = 0; i < 5; i++) { k.r.t += 1000; await k.flush(); }
    expect(k.r.logs.filter((l) => l.includes("not sent"))).toHaveLength(1);
    expect(k.r.posts[0]![0]!.text.length).toBe(2000);
  });
});
