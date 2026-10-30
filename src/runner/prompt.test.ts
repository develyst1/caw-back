import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChatPrompt, buildPrompt, folderNames, loadSkills, requirementsBlock, SHIPPED_SKILLS, threadOf, writeSkillsFile } from "./prompt";

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
  test("tells the worker to follow every requirement in spec.requirements and every rule in spec.decisions and spec.relatedDecisions, right after card_context (REQ-112 D1, REQ-118 SPEC-117 D1)", () => {
    expect(p).toContain("relatedDecisions");
    expect(p).toContain("2. Follow every requirement in `spec.requirements` and every rule in `spec.decisions` and `spec.relatedDecisions` of your card's context — the requirements bind every card, whatever its anchor; a rule on a related part applies to your card too.");
    expect(p.indexOf("relatedDecisions")).toBeGreaterThan(p.indexOf("1. Call the MCP tool `card_context`"));
  });
  test("SPEC-116 D3.2: with recipients it names each by name and role right after rule 3; with none the line is absent", () => {
    const two = buildPrompt({ worker, card, projectId: "p-1", recipients: [{ name: "แบงค์", roles: ["BE"] }, { name: "ฝน", roles: ["FE", "QA"] }] });
    const line = "You may hand off to: แบงค์ (BE), ฝน (FE + QA) — pass the name (or the id) as `toWorkerId` of `hand_off`.";
    expect(two).toContain(line);
    const lines = two.split("\n");
    expect(lines[lines.indexOf(line) - 1]).toStartWith("3. End this step with exactly one");
    expect(lines[lines.indexOf(line) + 1]).toStartWith("4. No git");
    expect(p).not.toContain("You may hand off to");
    expect(buildPrompt({ worker, card, projectId: "p-1", recipients: [] })).not.toContain("You may hand off to");
  });
  test("forbids git writes and web", () => {
    expect(p).toMatch(/no git/i);
    expect(p).toMatch(/no web/i);
  });
});

// REQ-117 (SPEC-114 D1/D2): CAW ships its own six role skills and loadSkills falls back to them — a fresh workspace root must not stop the first hop
describe("the shipped starter skills (REQ-117)", () => {
  const SIX = ["role-pm", "role-ba", "role-sa", "role-fe", "role-be", "role-qa"];
  const emptyRoot = () => mkdtempSync(join(tmpdir(), "caw-empty-root-"));
  const firstLine = (name: string) => readFileSync(join(SHIPPED_SKILLS, name, "SKILL.md"), "utf8").split("\n")[0]!;

  test("(a) an EMPTY root: role-pm loads, and its text holds the shipped file's first line", () => {
    const root = emptyRoot();
    try {
      const r = loadSkills(root, ["role-pm"]);
      expect(r.ok).toBe(true);
      expect((r as { text: string }).text).toContain(firstLine("role-pm"));
      expect((r as { text: string }).text).toContain("You are the team's PM.");
    } finally { rmSync(root, { recursive: true }); }
  });
  test("(b) a root that has its OWN role-pm: its text is used, the shipped one is not", () => {
    const root = emptyRoot();
    try {
      mkdirSync(join(root, ".claude/skills/role-pm"), { recursive: true });
      writeFileSync(join(root, ".claude/skills/role-pm/SKILL.md"), "THE OPERATOR'S OWN PM");
      const text = (loadSkills(root, ["role-pm", "role-sa"]) as { text: string }).text;
      expect(text).toContain("THE OPERATOR'S OWN PM");
      expect(text).not.toContain(firstLine("role-pm"));
      expect(text).toContain(firstLine("role-sa")); // the other name still falls back
    } finally { rmSync(root, { recursive: true }); }
  });
  test("(c) every one of the six names loads from an empty root, in order, each headed by its name; each file starts with the comment and ends with the Thai line", () => {
    const root = emptyRoot();
    try {
      const r = loadSkills(root, SIX);
      expect(r.ok).toBe(true);
      const text = (r as { text: string }).text;
      SIX.forEach((name, k) => { expect(text).toContain(`# Skill: ${name}`); if (k > 0) expect(text.indexOf(`# Skill: ${name}`)).toBeGreaterThan(text.indexOf(`# Skill: ${SIX[k - 1]}`)); });
      for (const name of SIX) {
        const file = readFileSync(join(SHIPPED_SKILLS, name, "SKILL.md"), "utf8");
        expect(file.startsWith(`<!-- CAW's own starter skill (REQ-117, SPEC-114 D2) — an operator's <CAW_WORKSPACE_ROOT>/.claude/skills/${name}/SKILL.md overrides it -->`)).toBe(true);
        expect(file.trimEnd().endsWith("Anything a user reads — card text, comments, questions — is in Thai, short and plain.")).toBe(true);
        // the PM's Q1 answer (2026-10-30): all six tell the worker to read the card's rules before asking the operator, and that line sits before the Thai one
        const ask = "Before you ask the operator anything, read the card's `spec.requirements`, `spec.decisions` and `spec.relatedDecisions`; ask only what they do not answer.";
        expect(file.split(ask)).toHaveLength(2);
        expect(file.indexOf(ask)).toBeLessThan(file.indexOf("Anything a user reads"));
      }
    } finally { rmSync(root, { recursive: true }); }
  });
  test("(d) the name checks hold for the shipped folder too: `../x`, `a/b` and a path into the shipped folder are missing; a name that exists nowhere is missing", () => {
    const root = emptyRoot();
    try {
      for (const bad of ["../x", "a/b", "../skills/role-pm", "..", "no-such-skill"]) expect(loadSkills(root, ["role-pm", bad])).toEqual({ ok: false, missing: bad });
    } finally { rmSync(root, { recursive: true }); }
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
  test("SPEC-117 D2.3: step 2b points at the requirements in the system prompt, right after step 2; step 3 allows requirement keys from it", () => {
    const b2 = "2b. The spec's requirements are in your system prompt (`# The spec's requirements`). Propose cards so that every requirement that asks for work is taken up by a card anchored on its key — a requirement key may be an anchor even when `locate` did not return it.";
    expect(p).toContain(`\n${b2}\n3. `);
    expect(p.indexOf(b2)).toBeGreaterThan(p.indexOf("\n2. Call `locate`"));
    expect(p).toContain("only for parts `locate` returned or requirement keys from your system prompt, every item anchored on a located key");
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

// REQ-118 (SPEC-117 D2.2): the entry chat hop's requirements block — appended to its system-prompt file, every text verbatim
describe("requirementsBlock", () => {
  const read = { revision: 7, requirements: [{ key: "REQ-001", title: "ล็อกอิน", text: "ผู้ใช้ต้องล็อกอินก่อน\nบรรทัดสอง" }, { key: "REQ-002", title: "รายงาน", text: "ส่งออก CSV" }] };
  test("the header with the revision, then `## KEY — title` and the text verbatim, a blank line between", () => {
    expect(requirementsBlock(read)).toBe([
      "# The spec's requirements (Blueprint revision 7) — they bind the whole project",
      "",
      "## REQ-001 — ล็อกอิน",
      "ผู้ใช้ต้องล็อกอินก่อน\nบรรทัดสอง",
      "",
      "## REQ-002 — รายงาน",
      "ส่งออก CSV",
    ].join("\n"));
  });
  test("no requirement → no block", () => {
    expect(requirementsBlock({ revision: 7, requirements: [] })).toBe("");
  });
  test("the read failed (null) → the one-line notice", () => {
    expect(requirementsBlock(null)).toBe("# The spec's requirements could not be read just now (Blueprint did not answer).");
  });
});
