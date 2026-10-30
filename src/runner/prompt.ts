// What one hop tells the worker (SPEC-C-003 § 2), and how its role skills reach it (R-6).
// A worker's cwd is a project repo, so the workspace's `.claude/skills` are not on its path: the runner reads each
// `worker.skills[i]` — first from <workspace>/.claude/skills/<name>/SKILL.md, then from CAW's own shipped starter skills (REQ-117, SPEC-114 D1) — and appends them to the system prompt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage } from "./api";

export type PromptWorker = { id: string; name: string; roles: string[]; skills: string[] };
export type PromptCard = { id: string; number: number; title: string; todo: string };

/** a worker this one may hand a card to (SPEC-116 D3.2) */
export type PromptRecipient = { name: string; roles: string[] };

/** another open work card of the project (SPEC-119 D2.2): its number, title, who holds it and its status — so the worker leaves that work to it */
export type PromptOtherCard = { number: number; title: string; assignee: string | null; status: string };

export function buildPrompt(input: { worker: PromptWorker; card: PromptCard; projectId: string; recipients?: PromptRecipient[]; others?: PromptOtherCard[] }): string {
  const { worker, card, projectId, recipients = [], others = [] } = input;
  return [
    `คุณคือ ${worker.name} (${worker.roles.join(" + ")}) ทีมงาน AI ใน CAW — your role skills are in your system prompt: follow them.`,
    `Your card is ${card.id} (#${card.number}) in project ${projectId}.`,
    "",
    "1. Call the MCP tool `card_context` first (with that cardId), then do the work.",
    // REQ-112 (SPEC-109 D1): a rule on a related part binds the card too — Blueprint puts those in `spec.relatedDecisions`.
    // REQ-118 (SPEC-117 D1): every requirement binds every card — Blueprint puts them in the part context's `requirements` field.
    // REQ-121 (SPEC-119 D2.1): they bind HOW the card's work is done; they are not this card's work list (TEST-106 P3-2: card #1 built all eight)
    "2. Do only your card's work — its title and its `todo`. Every requirement in `spec.requirements` and every rule in `spec.decisions` and `spec.relatedDecisions` binds how you do it (a rule on a related part applies to your card too); they are not a list of work for this card.",
    ...(others.length === 0 ? [] : [`Other cards hold their own work — leave it to them, even if you could do it now: ${others.map((o) => `#${o.number} ${o.title} (${o.assignee ?? "ยังไม่มีคนรับ"}, ${o.status})`).join("; ")}.`]),
    "3. End this step with exactly one of the MCP tools: `comment`, `hand_off`, `set_status`, `ask_operator`. To send a card to review, `set_status` with `review` needs `done` (what you did) and `howToTry` (how the owner tries it).",
    // SPEC-116 D3.2: the only other place a worker learns whom it may hand to is the refusal — say it up front, by name and role
    ...(recipients.length === 0 ? [] : [`You may hand off to: ${recipients.map((r) => `${r.name} (${r.roles.join(" + ")})`).join(", ")} — pass the name (or the id) as \`toWorkerId\` of \`hand_off\`.`]),
    "4. No git writes (no add, commit, push, branch, checkout). No web. Stay inside your working folders.",
    "5. If you cannot go on without a decision, use `ask_operator` with your proposed default — do not guess.",
    "6. In `comment` and `ask_operator` text, write line breaks as real new lines — never the two characters \\n.",
    "7. If you find work that no card holds, say so in a `comment` (what is missing and why) — do not build it yourself.",
  ].join("\n");
}

/** A skill name is a folder name: letters, digits, `.`, `_`, `-` — anything that could leave the skills folder is "missing". */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** CAW's own starter skills: `skills/<name>/SKILL.md` at the repo root (the six role names). A fallback, never a copy — nothing is written into the user's folder. */
export const SHIPPED_SKILLS = fileURLToPath(new URL("../../skills/", import.meta.url));

export type SkillsResult = { ok: true; text: string } | { ok: false; missing: string };

/** Each name: the workspace's own `<root>/.claude/skills/<name>/SKILL.md` first (an operator's skill wins), else CAW's shipped one, else `{ ok: false, missing }`.
 *  The name checks (`SAFE`, no `..`) run before either path is built. */
export function loadSkills(workspaceRoot: string, names: readonly string[], read: (path: string) => string = (p) => readFileSync(p, "utf8")): SkillsResult {
  const parts: string[] = [];
  for (const name of names) {
    if (!SAFE.test(name) || name.includes("..")) return { ok: false, missing: name };
    const own = join(workspaceRoot, ".claude", "skills", name, "SKILL.md");
    const shipped = join(SHIPPED_SKILLS, name, "SKILL.md");
    const path = existsSync(own) ? own : existsSync(shipped) ? shipped : null;
    if (path === null) return { ok: false, missing: name };
    parts.push(`# Skill: ${name}\n\n${read(path)}`);
  }
  return { ok: true, text: parts.join("\n\n---\n\n") };
}

export type Requirements = { revision: number; requirements: { key: string; title: string; text: string }[] };

/** The entry chat hop's requirements block, appended to its system-prompt file (SPEC-117 D2.2): every requirement, `text` verbatim.
 *  `null` = the read failed → the one-line notice; no requirement → "" (no block). */
export function requirementsBlock(read: Requirements | null): string {
  if (read === null) return "# The spec's requirements could not be read just now (Blueprint did not answer).";
  if (read.requirements.length === 0) return "";
  return [`# The spec's requirements (Blueprint revision ${read.revision}) — they bind the whole project`, ...read.requirements.map((r) => `## ${r.key} — ${r.title}\n${r.text}`)].join("\n\n");
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

/** The folders by the names the screen and the replies use (D-098): the last path segment; when two roots share one, `parent/last` — and further up
 *  while they still collide. A name that collides with nothing stays short. Never an absolute path. */
export function folderNames(roots: readonly string[]): string[] {
  const parts = roots.map((r) => r.split("/").filter((x) => x !== ""));
  const depth = parts.map(() => 1);
  const name = (i: number) => parts[i]!.slice(-depth[i]!).join("/");
  for (let guard = 0; guard < 64; guard++) {
    const seen = new Map<string, number[]>();
    parts.forEach((_, i) => seen.set(name(i), [...(seen.get(name(i)) ?? []), i]));
    const clashing = [...seen.values()].filter((g) => g.length > 1).flat().filter((i) => depth[i]! < parts[i]!.length);
    if (clashing.length === 0) break;
    for (const i of clashing) depth[i]!++;
  }
  return parts.map((_, i) => name(i));
}

/** The entry worker's CHAT hop (SPEC-C-004 § 1 step 3; REQ-013). The words in braces are REQ-013's, said exactly. `locate` needs the project id. */
export function buildChatPrompt(input: { worker: PromptWorker; messageId: string; projectId: string; thread?: Thread | null; folders?: string[] }): string {
  const { worker, messageId, projectId, thread, folders } = input;
  return [
    `คุณคือ ${worker.name} (${worker.roles.join(" + ")}) ผู้รับแชตของโปรเจกต์ใน CAW — your role skills are in your system prompt: follow them.`,
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
    ...(folders && folders.length > 0 ? [`Folders: ${folders.join(", ")}`, ""] : []),
    "0. If the message asks you to understand the project — which folders hold what, the stack, how to run and test, the house rules — it is SETUP, not a feature. For SETUP:",
    "   - do not call `locate`, `send_amendment` or `propose_cards`;",
    "   - read the folders listed above (Read / Glob / Grep only, at most about 40 reads);",
    "   - call `save_code_map` once with the structured map: `folders` (every folder, each `{ name, kind: fe | be | other, note }` — the note says why, in Thai, one line), `stack`, `commands.run` and `commands.test` (lists), `rules` (file names, or an empty list), `questions` (each `{ text, proposedDefault }`), and `notes` only if needed; every string at most 500 characters;",
    "   - then `reply` in a few lines: what you mapped, and ask the operator to confirm the map.",
    "   Anything that is not SETUP is a feature request: do not read any file — go to step 1 (`chat_context`, then `locate`) and follow steps 1–6.",
    "",
    "1. Read it with the MCP tool `chat_context` (messageId above).",
    `2. Call \`locate\` { projectId: "${projectId}", request } before anything else: it tells you which parts of the confirmed spec the request touches.`,
    // REQ-118 (SPEC-117 D2.3): the requirements are in the system prompt (hop.ts appends the block), and their keys may be anchors
    "2b. The spec's requirements are in your system prompt (`# The spec's requirements`). Propose cards so that every requirement that asks for work is taken up by a card anchored on its key — a requirement key may be an anchor even when `locate` did not return it.",
    "3. If `locate` returned parts (candidates) for the request, propose cards for them with `propose_cards` — only for parts `locate` returned or requirement keys from your system prompt, every item anchored on a located key, each with your estimate of `hops`, and each given (`workerId`) to the chain member whose role does that work — a page or screen to the FE, the server and data to the BE. Nothing is made until the operator accepts. Missing details are not a reason to hold the proposal back: put the questions in your reply (step 5).",
    "4. Use `send_amendment` ONLY for what `locate` did not return (`notInSpec`), or when the request changes the spec itself — it asks Blueprint's chat to change the spec; do not invent a card for it.",
    "5. If you need decisions first, put ALL your questions in the one reply as `questions[]`, each with `text`, `proposedDefault` and `cases` — never one question at a time.",
    "6. Always end with exactly one `reply` in Thai. `reply` is mandatory — if you cannot do anything else, reply and say what blocks you.",
    "   - Write line breaks as real new lines in `text` — never the two characters \\n.",
    "   - In every reply: never write a path that starts with `/` or `~`; use `<folder>/<path inside>`. Never print an id (no uuid, no message id). Never tell the operator to go to Blueprint in your text — with an amendment, pass `amendment.blueprintMessageId` and the screen shows the link.",
    "   - With a proposal the text contains: `{n} งาน ใช้ประมาณ {h} ก้าว` (n = the number of cards, h = the sum of the hops) and you pass `proposalId`.",
    "   - With an amendment the text contains: `เรื่องนี้ยังไม่มีใน spec — ส่งไปเพิ่มใน Blueprint แล้ว` and the link, and you pass `amendment.blueprintMessageId`.",
    "",
    "No git writes, no web, no file writes: this is a conversation, not coding.",
  ].join("\n");
}
