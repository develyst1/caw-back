// What one hop tells the worker (SPEC-C-003 § 2), and how its role skills reach it (R-6).
// A worker's cwd is a project repo, so the workspace's `.claude/skills` are not on its path: the runner reads each
// `worker.skills[i]` from <workspace>/.claude/skills/<name>/SKILL.md and appends them to the system prompt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "./api";

export type PromptWorker = { id: string; name: string; role: string; skills: string[] };
export type PromptCard = { id: string; number: number; title: string; todo: string };

export function buildPrompt(input: { worker: PromptWorker; card: PromptCard; projectId: string }): string {
  const { worker, card, projectId } = input;
  return [
    `คุณคือ ${worker.name} (${worker.role}) ทีมงาน AI ใน CAW — your role skills are in your system prompt: follow them.`,
    `Your card is ${card.id} (#${card.number}) in project ${projectId}.`,
    "",
    "1. Call the MCP tool `card_context` first (with that cardId), then do the work.",
    "2. End this step with exactly one of the MCP tools: `comment`, `hand_off`, `set_status`, `ask_operator`.",
    "3. No git writes (no add, commit, push, branch, checkout). No web. Stay inside your working folders.",
    "4. If you cannot go on without a decision, use `ask_operator` with your proposed default — do not guess.",
  ].join("\n");
}

/** A skill name is a folder name: letters, digits, `.`, `_`, `-` — anything that could leave the skills folder is "missing". */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type SkillsResult = { ok: true; text: string } | { ok: false; missing: string };

export function loadSkills(workspaceRoot: string, names: readonly string[], read: (path: string) => string = (p) => readFileSync(p, "utf8")): SkillsResult {
  const parts: string[] = [];
  for (const name of names) {
    const path = join(workspaceRoot, ".claude", "skills", name, "SKILL.md");
    if (!SAFE.test(name) || name.includes("..") || !existsSync(path)) return { ok: false, missing: name };
    parts.push(`# Skill: ${name}\n\n${read(path)}`);
  }
  return { ok: true, text: parts.join("\n\n---\n\n") };
}

export function writeSkillsFile(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "skills.md");
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

/** What a follow-up needs besides its own words (TASK-C-036): the worker's questions it answers and the operator's ORIGINAL request, the top of the thread. */
export type Thread = { original: string | null; questions: string[] };

/** `messages` oldest first. A message right after the worker's question pack ANSWERS it; anything else is a fresh request (null). With several
 *  rounds of questions the original is walked back to the top and the questions are the latest pack. */
export function threadOf(messages: readonly ChatMessage[], messageId: string): Thread | null {
  const at = messages.findIndex((m) => m.id === messageId);
  const prev = at > 0 ? messages[at - 1]! : undefined;
  if (!prev || prev.author === "operator" || !prev.questions?.length) return null;
  const pack = (m: ChatMessage | undefined) => (m && m.author !== "operator" && m.questions?.length ? m : null);
  let cur = messages.find((m) => m.id === prev.replyTo);
  for (let i = 0; i < 10 && cur; i++) {
    const before = pack(messages[messages.indexOf(cur) - 1]);
    const up = before?.replyTo ? messages.find((m) => m.id === before.replyTo) : undefined;
    if (!up) break;
    cur = up;
  }
  return { original: cur?.text ?? null, questions: prev.questions.map((q) => q.text) };
}

/** The entry worker's CHAT hop (SPEC-C-004 § 1 step 3; REQ-013). The words in braces are REQ-013's, said exactly. `locate` needs the project id. */
export function buildChatPrompt(input: { worker: PromptWorker; messageId: string; projectId: string; thread?: Thread | null }): string {
  const { worker, messageId, projectId, thread } = input;
  return [
    `คุณคือ ${worker.name} (${worker.role}) ผู้รับแชตของโปรเจกต์ใน CAW — your role skills are in your system prompt: follow them.`,
    `The operator wrote message ${messageId} in project ${projectId}.`,
    "",
    ...(thread ? [
      "",
      "This message answers your questions. You asked:",
      ...thread.questions.map((q, i) => `   ${i + 1}. ${q}`),
      ...(thread.original !== null ? [`The operator's original request was: ${thread.original}`] : []),
      "Use the original request (not this message) for `locate`; apply these answers to the proposal; then propose / amend / reply as usual.",
      "",
    ] : []),
    "1. Read it with the MCP tool `chat_context` (messageId above).",
    `2. Call \`locate\` { projectId: "${projectId}", request } before anything else: it tells you which parts of the confirmed spec the request touches.`,
    "3. If `locate` returned parts (candidates) for the request, propose cards for them with `propose_cards` — only for parts `locate` returned, every item anchored on a located key, each with your estimate of `hops`. Nothing is made until the operator accepts. Missing details are not a reason to hold the proposal back: put the questions in your reply (step 5).",
    "4. Use `send_amendment` ONLY for what `locate` did not return (`notInSpec`), or when the request changes the spec itself — it asks Blueprint's chat to change the spec; do not invent a card for it.",
    "5. If you need decisions first, put ALL your questions in the one reply as `questions[]`, each with `text`, `proposedDefault` and `cases` — never one question at a time.",
    "6. Always end with exactly one `reply` in Thai. `reply` is mandatory — if you cannot do anything else, reply and say what blocks you.",
    "   - With a proposal the text contains: `{n} งาน ใช้ประมาณ {h} ก้าว` (n = the number of cards, h = the sum of the hops) and you pass `proposalId`.",
    "   - With an amendment the text contains: `เรื่องนี้ยังไม่มีใน spec — ส่งไปเพิ่มใน Blueprint แล้ว` and the link, and you pass `amendment.blueprintMessageId`.",
    "",
    "No git writes, no web, no files: this is a conversation, not coding.",
  ].join("\n");
}
