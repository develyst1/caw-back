import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChatPrompt, buildPrompt, folderNames, loadSkills, threadOf, writeSkillsFile } from "./prompt";

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
  test("tells the worker to follow every rule in spec.decisions and spec.relatedDecisions, right after card_context (REQ-112, SPEC-109 D1)", () => {
    expect(p).toContain("relatedDecisions");
    expect(p).toContain("2. Follow every rule in `spec.decisions` and `spec.relatedDecisions` of your card's context");
    expect(p.indexOf("relatedDecisions")).toBeGreaterThan(p.indexOf("1. Call the MCP tool `card_context`"));
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
  test("reads the message with chat_context and locates BEFORE anything else (steps 1 and 2; the SETUP step before them only says what NOT to call)", () => {
    expect(p.indexOf("\n1. Read it with the MCP tool `chat_context`")).toBeGreaterThan(-1);
    expect(p.indexOf("\n2. Call `locate`")).toBeGreaterThan(p.indexOf("\n1. Read it with the MCP tool `chat_context`"));
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
  test("the card prompt has rule 6 for `comment` and `ask_operator` text, once", () => {
    const p = buildPrompt({ worker, card, projectId: "p-1" });
    const rule = "6. In `comment` and `ask_operator` text, write line breaks as real new lines — never the two characters \\n.";
    expect(count(p, rule)).toBe(1);
    expect(p.indexOf(rule)).toBeGreaterThan(p.indexOf("5. If you cannot go on")); // REQ-112 inserted rule 2, so this was 5 / 4
  });
});

describe("the setup step and the folders (TASK-C-041, REQ-015 R2/R3, D-098)", () => {
  const roots = ["/x/y/usb-oda", "/x/y/mc2-front"];
  const prompt = () => buildChatPrompt({ worker, messageId: "m-1", projectId: "p-1", folders: folderNames(roots) });

  test("folderNames: the last path segment; `parent/last` when two roots share one; a single root is its last segment", () => {
    expect(folderNames(["/x/y/usb-oda", "/x/y/mc2-front"])).toEqual(["usb-oda", "mc2-front"]);
    expect(folderNames(["/a/x/usb-oda", "/b/y/usb-oda"])).toEqual(["x/usb-oda", "y/usb-oda"]);
    expect(folderNames(["/only/one/"])).toEqual(["one"]);
    expect(folderNames([])).toEqual([]);
  });
  test("folderNames: a collision that survives one parent goes up another level; a folder that is not in a collision keeps its short name", () => {
    expect(folderNames(["/a/x/app", "/b/x/app", "/c/lib"])).toEqual(["a/x/app", "b/x/app", "lib"]);
  });
  test("the folders are listed by name and the prompt holds no machine path", () => {
    const p = prompt();
    expect(p).toContain("Folders: usb-oda, mc2-front");
    expect(p).not.toContain("/x/y");
    expect(p).not.toContain("/Users/");
  });
  test("no roots, no `Folders:` line", () => {
    expect(buildChatPrompt({ worker, messageId: "m-1", projectId: "p-1", folders: [] })).not.toContain("Folders:");
    expect(buildChatPrompt({ worker, messageId: "m-1", projectId: "p-1" })).not.toContain("Folders:");
  });
  test("the SETUP step is there once, BEFORE step 1, and it names save_code_map, the read-only tools and the shape of the map", () => {
    const p = prompt();
    const at = p.indexOf("0. ");
    expect(p.split("SETUP").length - 1).toBeGreaterThanOrEqual(1);
    expect(p.split("\n0. ").length - 1).toBe(1);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(p.indexOf("\n1. Read it with"));
    const setup = p.slice(at, p.indexOf("\n1. Read it with"));
    for (const w of ["save_code_map", "Read / Glob / Grep", "folders", "stack", "commands.run", "commands.test", "rules", "questions", "500", "reply"]) expect(setup).toContain(w);
    expect(setup).toMatch(/do not call `locate`, `send_amendment` or `propose_cards`/);
  });
  test("the LAST line of step 0 sends everything that is not SETUP to step 1 with NO file read (TASK-C-041 Q2: a payroll request globbed an empty root before locate)", () => {
    const p = prompt();
    const step0 = p.slice(p.indexOf("\n0. "), p.indexOf("\n1. Read it with"));
    const lines = step0.split("\n").filter((l) => l.trim() !== "");
    expect(lines[lines.length - 1]).toBe("   Anything that is not SETUP is a feature request: do not read any file — go to step 1 (`chat_context`, then `locate`) and follow steps 1–6.");
    expect(p.split("do not read any file").length - 1).toBe(1);
  });
  test("feature requests keep steps 1 to 6 as they were (REQ-013, AC-4)", () => {
    const p = prompt();
    for (const w of ["1. Read it with the MCP tool `chat_context`", "2. Call `locate`", "3. If `locate` returned parts", "4. Use `send_amendment` ONLY", "5. If you need decisions first", "6. Always end with exactly one `reply` in Thai."]) expect(p).toContain(w);
    expect(p.indexOf("\n2. Call")).toBeGreaterThan(p.indexOf("\n1. Read it"));
  });
  test("the three reply rules: no path starting with / or ~, no ids, never send the operator to Blueprint in the text", () => {
    const p = prompt();
    expect(p).toMatch(/never write a path that starts with `\/` or `~`; use `<folder>\/<path inside>`/);
    expect(p).toMatch(/never print an id/i);
    expect(p).toMatch(/never tell the operator to go to Blueprint in your text/i);
    expect(p).toContain("amendment.blueprintMessageId");
  });
  test("the closing line no longer says `no files` (reading is allowed now), but still no git writes and no web", () => {
    const p = prompt();
    expect(p).not.toContain("no files");
    expect(p).toContain("No git writes, no web, no file writes");
  });
});
