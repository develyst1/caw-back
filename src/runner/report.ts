// The run report (REQ-012 R7, AC-7; SPEC-C-003 § 5): short Thai text with five parts, built ONLY from what the API says — hops of the run, the
// project's cards, the run's events — so it cannot disagree with the store. Pure: the caller does the reads and hands them in.
// Words: the five part names are REQ-012's; the line wording ("ส่ง … ต่อให้", "เหตุที่จบรอบ", "โทเค็น" …) was team-proposed; the PM fixed the vocabulary 2026-10-14 (REQ-012 l.49).
import type { ApiEvent, Hop } from "./api";
import { formatDuration } from "./thai";

export type ReportCard = { id: string; number: number; title: string; kind: "work" | "question"; status: string; question: { text: string } | null; answer: string | null };
export type ReportInput = {
  run: { hopBudget: number; startedAt: string };
  now: Date;
  /** the stop reason in REQ-012's words */
  reasonWords: string;
  /** the hops of this run, any order */
  hops: Hop[];
  /** every card of the project */
  cards: ReportCard[];
  /** the project's events from the run's start on */
  events: ApiEvent[];
  workerNames: Record<string, string>;
};

const LIMIT = 20000; // PATCH /v1/runs/{id} refuses a longer report
/** One vocabulary with the screens (REQ-012 l.49): a status is always printed with its board-column word, never as the code. */
export const STATUS_WORDS: Record<string, string> = { todo: "รอทำ", doing: "กำลังทำ", review: "รอตรวจ", done: "เสร็จ", stuck: "ติดอยู่" };
const statusWord = (code: unknown) => STATUS_WORDS[String(code)] ?? "ไม่ทราบสถานะ"; // an unknown code is not shown raw either
const OUTCOME_WORDS: Record<string, string> = { failed: "ไม่สำเร็จ", stopped: "หยุดไว้", interrupted: "ถูกขัดจังหวะ" };
const NONE = "- ไม่มี";
const n = (v: number) => v.toLocaleString("en-US");

/** "หยุดไว้: …" when the stored note already starts with the word (a blocked hop's does), so it is not said twice. */
const hopLine = (word: string, note: string) => (note === "" ? word : note.startsWith(word) ? note : `${word}: ${note}`);

export function buildReport(i: ReportInput): string {
  const byId = new Map(i.cards.map((c) => [c.id, c]));
  const num = (cardId: unknown) => `#${byId.get(String(cardId))?.number ?? "?"}`;
  const worker = (id: unknown) => i.workerNames[String(id)] ?? "ทีมงาน";
  const workerEvents = i.events.filter((e) => e.actor.startsWith("worker:"));

  const done = i.cards
    .filter((c) => c.status === "done" && i.events.some((e) => e.type === "card.status_set" && e.data?.cardId === c.id && e.data?.status === "done"))
    .sort((a, b) => a.number - b.number)
    .map((c) => `- #${c.number} ${c.title}`);

  const decided = workerEvents.flatMap((e) => {
    const who = worker(e.actor.slice("worker:".length));
    if (e.type === "card.handed_off") return [`- ${who}: ส่ง ${num(e.data?.cardId)} ต่อให้ ${worker(e.data?.toWorkerId)}`];
    if (e.type === "card.status_set") return [`- ${who}: เปลี่ยน ${num(e.data?.cardId)} เป็น ${statusWord(e.data?.status)}`];
    return [];
  });

  const waiting = i.cards
    .filter((c) => c.kind === "question" && c.answer === null)
    .sort((a, b) => a.number - b.number)
    .map((c) => `- #${c.number} ${c.question?.text ?? c.title}`);

  const hops = [...i.hops].sort((a, b) => (a.id < b.id ? -1 : 1));
  const problems = hops.flatMap((h, k) =>
    h.outcome === null
      ? [`- ก้าว ${k + 1} (${num(h.cardId)}) ยังทำอยู่`] // a stop that does not wait for the hop in progress: say so, do not hide it
      : OUTCOME_WORDS[h.outcome]
        ? [`- ก้าว ${k + 1} (${num(h.cardId)}) ${hopLine(OUTCOME_WORDS[h.outcome]!, h.note)}`]
        : []);
  problems.push(`- เหตุที่จบรอบ: ${i.reasonWords}`);

  const tokensIn = hops.reduce((s, h) => s + (h.tokensIn ?? 0), 0);
  const tokensOut = hops.reduce((s, h) => s + (h.tokensOut ?? 0), 0);
  const cost = [
    `- ${hops.length} ก้าว จากงบ ${i.run.hopBudget}`,
    `- โทเค็นเข้า ${n(tokensIn)} ออก ${n(tokensOut)}`,
    `- ใช้เวลา ${formatDuration(i.now.getTime() - Date.parse(i.run.startedAt))}`,
  ];

  const text = [
    "เสร็จแล้ว", ...(done.length ? done : [NONE]),
    "ทีมตัดสินเอง", ...(decided.length ? decided : [NONE]),
    "รอคุณ", ...(waiting.length ? waiting : [NONE]),
    "ปัญหา", ...problems,
    "ค่าใช้จ่าย", ...cost,
  ].join("\n");
  return text.length > LIMIT ? `${text.slice(0, LIMIT - 1)}…` : text;
}
