import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChatPrompt, buildPrompt, loadSkills, threadOf, writeSkillsFile } from "./prompt";

const worker = { id: "w-1", name: "Blew", roles: ["BE"], skills: ["role-be"] };
const card = { id: "c-1", number: 7, title: "ทำหน้าอนุมัติ", todo: "ทำตาม STEP-004" };

describe("buildPrompt (SPEC-C-003 § 2)", () => {
  const p = buildPrompt({ worker, card, projectId: "p-1" });
  test("names the worker, the card and the project, and says to call card_context first", () => {
    expect(p).toContain("Blew");
    expect(p).toContain("c-1");
    expect(p).toContain("p-1");
    expect(p.indexOf("card_context")).toBeGreaterThan(-1);
  });
  test("ends the hop with exactly one of comment / hand_off / set_status / ask_operator", () => {
    for (const t of ["comment", "hand_off", "set_status", "ask_operator"]) expect(p).toContain(t);
    expect(p).toMatch(/exactly one/i);
  });
  test("forbids git writes and web", () => {
    expect(p).toMatch(/no git/i);
    expect(p).toMatch(/no web/i);
  });
});

describe("loadSkills", () => {
  const root = mkdtempSync(join(tmpdir(), "caw-skills-test-"));
  const skill = (name: string, body: string) => { mkdirSync(join(root, ".claude/skills", name), { recursive: true }); writeFileSync(join(root, ".claude/skills", name, "SKILL.md"), body); };
  skill("role-be", "BE craft"); skill("workforce-protocol", "desk mechanics");

  test("joins each SKILL.md in worker order, headed by its name", () => {
    const r = loadSkills(root, ["workforce-protocol", "role-be"]);
    expect(r).toEqual({ ok: true, text: expect.any(String) });
    const text = (r as { text: string }).text;
    expect(text.indexOf("desk mechanics")).toBeLessThan(text.indexOf("BE craft"));
    expect(text).toContain("workforce-protocol");
  });
  test("a missing skill refuses, naming the first one that is missing", () => {
    expect(loadSkills(root, ["role-be", "no-such-skill", "also-missing"])).toEqual({ ok: false, missing: "no-such-skill" });
  });
  test("a name that tries to leave the skills folder counts as missing", () => {
    expect(loadSkills(root, ["../../etc/passwd"])).toEqual({ ok: false, missing: "../../etc/passwd" });
    expect(loadSkills(root, ["a/b"])).toEqual({ ok: false, missing: "a/b" });
  });
  test("no skills at all is an empty text, not a refusal", () => {
    expect(loadSkills(root, [])).toEqual({ ok: true, text: "" });
  });
  test("writeSkillsFile puts the text in a file under the given folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "caw-skills-out-"));
    try { const f = writeSkillsFile(join(dir, "in"), "hello"); expect(readFileSync(f, "utf8")).toBe("hello"); expect(statSync(f).mode & 0o777).toBe(0o600); expect(statSync(join(dir, "in")).mode & 0o777).toBe(0o700); } finally { rmSync(dir, { recursive: true }); rmSync(root, { recursive: true }); }
  });
});

describe("buildChatPrompt (SPEC-C-004 § 1 step 3)", () => {
  const p = buildChatPrompt({ worker, messageId: "m-1", projectId: "p-1" });
  test("names the worker, the message and the PROJECT (locate needs the project id)", () => {
    expect(p).toContain("Blew");
    expect(p).toContain("m-1");
    expect(p).toContain("p-1");
  });
  test("reads the message with chat_context and locates BEFORE anything else", () => {
    expect(p.indexOf("chat_context")).toBeGreaterThan(-1);
    expect(p.indexOf("locate")).toBeGreaterThan(p.indexOf("chat_context"));
    expect(p).toMatch(/locate[^\n]*before anything else|before anything else[^\n]*locate/i);
  });
  test("proposes cards only for parts locate returned, amends for what is not in the spec, and always ends with one reply in Thai", () => {
    expect(p).toContain("propose_cards");
    expect(p).toMatch(/only for parts/i);
    expect(p).toContain("send_amendment");
    expect(p).toMatch(/always[^\n]*reply[^\n]*Thai/i);
  });
  test("carries REQ-013's exact words for the reply", () => {
    expect(p).toContain("{n} งาน ใช้ประมาณ {h} ก้าว");
    expect(p).toContain("เรื่องนี้ยังไม่มีใน spec — ส่งไปเพิ่มใน Blueprint แล้ว");
  });
  test("found parts → propose; send_amendment ONLY for what locate did not return (a real hop amended a request locate HAD found — TASK-C-034 attempt 1)", () => {
    expect(p).toMatch(/if .?locate.? returned (parts|candidates)[^\n]*propose/i);
    expect(p).toMatch(/send_amendment[^\n]*only[^\n]*(notInSpec|did not return|not in the spec)/i);
    expect(p).toMatch(/missing details[^\n]*questions|questions[^\n]*missing details/i);
  });
  test("decisions come in ONE reply as questions[], each with proposedDefault (R5)", () => {
    expect(p).toContain("questions");
    expect(p).toContain("proposedDefault");
    expect(p).toMatch(/all your questions/i);
  });
  test("no git writes, no web, no card tools, no files", () => {
    expect(p).toMatch(/no git/i);
    expect(p).toMatch(/no web/i);
    expect(p).not.toContain("hand_off");
  });
});

describe("the follow-up in a thread (TASK-C-036)", () => {
  const base = { replyHopId: null, at: "", projectId: "p-1", retryRequestedAt: null };
  const op = (id: string, text: string) => ({ ...base, id, author: "operator", text, replyTo: null, questions: null });
  const bot = (id: string, replyTo: string, qs: string[] | null) => ({ ...base, id, author: "worker:w-1", text: "ขอถาม", replyTo, questions: qs ? qs.map((text) => ({ text })) : null });

  test("a message right after the worker's question pack answers it: the questions and the original request", () => {
    const t = threadOf([op("m1", "แก้ขั้นอนุมัติห้องใหญ่"), bot("m2", "m1", ["ใช้สีไหน", "ใครอนุมัติ"]), op("m3", "1. ตามนั้น 2. ผู้จัดการ")], "m3");
    expect(t).toEqual({ original: "แก้ขั้นอนุมัติห้องใหญ่", questions: ["ใช้สีไหน", "ใครอนุมัติ"] });
  });
  test("a first message, or one after a plain reply (no questions), is a fresh request: no thread", () => {
    expect(threadOf([op("m1", "x")], "m1")).toBeNull();
    expect(threadOf([op("m1", "x"), bot("m2", "m1", null), op("m3", "y")], "m3")).toBeNull();
  });
  test("two rounds of questions: the ORIGINAL is the top of the thread, the questions are the latest pack", () => {
    const t = threadOf([op("m1", "คำขอแรก"), bot("m2", "m1", ["q1"]), op("m3", "a1"), bot("m4", "m3", ["q2"]), op("m5", "a2")], "m5");
    expect(t).toEqual({ original: "คำขอแรก", questions: ["q2"] });
  });
  test("a message that is not in the list gives no thread", () => {
    expect(threadOf([op("m1", "x")], "nope")).toBeNull();
  });
  test("with a thread the prompt says: this answers your questions; use the ORIGINAL request for locate; apply the answers", () => {
    const p = buildChatPrompt({ worker, messageId: "m3", projectId: "p-1", thread: { original: "แก้ขั้นอนุมัติห้องใหญ่", questions: ["ใช้สีไหน"] } });
    expect(p).toContain("answers your questions");
    expect(p).toContain("แก้ขั้นอนุมัติห้องใหญ่");
    expect(p).toContain("ใช้สีไหน");
    expect(p).toMatch(/original request[^\n]*locate|locate[^\n]*original request/i);
  });
  test("without a thread the prompt has no such section", () => {
    const p = buildChatPrompt({ worker, messageId: "m1", projectId: "p-1" });
    expect(p).not.toContain("answers your questions");
  });
  test("reply is mandatory in both: if nothing else can be done, reply and say what blocks", () => {
    for (const thread of [undefined, { original: "x", questions: ["q"] }]) {
      expect(buildChatPrompt({ worker, messageId: "m", projectId: "p", thread })).toMatch(/reply[^\n]*mandatory[^\n]*blocks|if you cannot[^\n]*reply[^\n]*what blocks/i);
    }
  });
});

describe("the worker's roles in the prompt (TASK-C-037, contract v1.10)", () => {
  const two = { id: "w-2", name: "ฝน", roles: ["FE", "BE"], skills: ["role-fe", "role-be"] };
  test("the card prompt prints every role joined with ' + '", () => {
    expect(buildPrompt({ worker: two, card, projectId: "p-1" })).toContain("คุณคือ ฝน (FE + BE) ทีมงาน AI ใน CAW");
  });
  test("the chat prompt prints every role joined with ' + '", () => {
    expect(buildChatPrompt({ worker: two, messageId: "m-1", projectId: "p-1" })).toContain("คุณคือ ฝน (FE + BE) ผู้รับแชตของโปรเจกต์ใน CAW");
  });
  test("one role prints as before", () => {
    expect(buildPrompt({ worker, card, projectId: "p-1" })).toContain("คุณคือ Blew (BE) ทีมงาน AI ใน CAW");
    expect(buildChatPrompt({ worker, messageId: "m-1", projectId: "p-1" })).toContain("คุณคือ Blew (BE) ผู้รับแชตของโปรเจกต์ใน CAW");
  });
});

describe("real line breaks in the worker's text (TASK-C-039, D-077)", () => {
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  test("the chat prompt asks for real new lines in `text`, once, and names the two characters backslash + n", () => {
    const p = buildChatPrompt({ worker, messageId: "m-1", projectId: "p-1" });
    const line = "   - Write line breaks as real new lines in `text` — never the two characters \\n.";
    expect(count(p, line)).toBe(1);
    expect(p).toContain("never the two characters \\n"); // backslash + n, as the model reads it
    expect(p).not.toContain("never the two characters \\\\n"); // not a doubled backslash
    expect(p.indexOf(line)).toBeGreaterThan(p.indexOf("`reply` is mandatory")); // a sub-line of step 6
  });
  test("the card prompt has rule 5 for `comment` and `ask_operator` text, once", () => {
    const p = buildPrompt({ worker, card, projectId: "p-1" });
    const rule = "5. In `comment` and `ask_operator` text, write line breaks as real new lines — never the two characters \\n.";
    expect(count(p, rule)).toBe(1);
    expect(p.indexOf(rule)).toBeGreaterThan(p.indexOf("4. If you cannot go on"));
  });
});
