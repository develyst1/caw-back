// buildReport on a scripted store, against one fixed expected text (REQ-012 R7, AC-7). Everything in it comes from API reads.
import { describe, expect, test } from "bun:test";
import type { ApiEvent, Hop } from "./api";
import { type ReportInput, buildReport } from "./report";

const hop = (n: number, cardId: string, outcome: Hop["outcome"], over: Partial<Hop> = {}): Hop => ({
  id: `h${n}`, projectId: "p", runId: "r1", claimedBy: "i", cardId, messageId: null, workerId: "w1", startedAt: "t", endedAt: "t", outcome, tokensIn: null, tokensOut: null, note: "", ...over,
});
let seq = 0;
const ev = (type: string, data: object, actor = "worker:w1"): ApiEvent => ({ seq: ++seq, projectId: "p", type, actor, at: "t", data });
const card = (number: number, title: string, status: string, over: object = {}) => ({ id: `c${number}`, number, title, kind: "work" as const, status, question: null, answer: null, ...over });

const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  run: { hopBudget: 5, startedAt: "2026-10-14T10:00:00.000Z" },
  now: new Date("2026-10-14T10:02:14.000Z"),
  reasonWords: "ใช้งบครบแล้ว",
  hops: [], cards: [], events: [], workerNames: { w1: "Blew", w2: "Next" },
  ...over,
});

describe("buildReport", () => {
  test("a run with one of everything: the five parts, in order, one fixed text", () => {
    seq = 0;
    const text = buildReport(base({
      hops: [
        hop(1, "c1", "commented", { tokensIn: 1200, tokensOut: 300 }),
        hop(2, "c2", "asked", { tokensIn: 3400, tokensOut: 500 }),
        hop(3, "c3", "stopped", { note: "หยุดไว้: Blew พยายาม Bash: git push origin HEAD ซึ่งไม่อนุญาต" }),
      ],
      cards: [
        card(1, "ทำหน้าอนุมัติ", "done"), card(2, "ออกแบบตาราง", "todo"), card(3, "ส่งอีเมล", "todo"),
        card(4, "ถามเรื่องสี", "todo", { kind: "question", question: { text: "ใช้สีไหน?", proposedDefault: "น้ำเงิน", cases: ["a"] } }),
        card(5, "ถามที่ตอบแล้ว", "done", { kind: "question", question: { text: "เก่า?", proposedDefault: "x", cases: ["a"] }, answer: "ตกลง" }),
      ],
      events: [
        ev("card.status_set", { cardId: "c1", status: "review" }),
        ev("card.status_set", { cardId: "c1", status: "done" }, "operator"),
        ev("card.handed_off", { cardId: "c2", fromWorkerId: "w1", toWorkerId: "w2", text: "x" }),
        ev("card.commented", { cardId: "c2", text: "ignored: a comment is not a decision" }),
      ],
    }));
    expect(text).toBe([
      "เสร็จแล้ว",
      "- #1 ทำหน้าอนุมัติ",
      "ทีมตัดสินเอง",
      "- Blew: เปลี่ยน #1 เป็น รอตรวจ",
      "- Blew: ส่ง #2 ต่อให้ Next",
      "รอคุณ",
      "- #4 ใช้สีไหน?",
      "ปัญหา",
      "- ก้าว 3 (#3) หยุดไว้: Blew พยายาม Bash: git push origin HEAD ซึ่งไม่อนุญาต", // the note already starts with the word: it is not said twice
      "- เหตุที่จบรอบ: ใช้งบครบแล้ว",
      "ค่าใช้จ่าย",
      "- 3 ก้าว จากงบ 5",
      "- โทเค็นเข้า 4,600 ออก 800",
      "- ใช้เวลา 2 นาที 14 วินาที",
    ].join("\n"));
  });

  test("an empty run says `ไม่มี` under each part, and the reason still closes `ปัญหา`", () => {
    const text = buildReport(base({ reasonWords: "ไม่มีงานที่ทำต่อได้" }));
    expect(text).toBe([
      "เสร็จแล้ว", "- ไม่มี", "ทีมตัดสินเอง", "- ไม่มี", "รอคุณ", "- ไม่มี", "ปัญหา", "- เหตุที่จบรอบ: ไม่มีงานที่ทำต่อได้",
      "ค่าใช้จ่าย", "- 0 ก้าว จากงบ 5", "- โทเค็นเข้า 0 ออก 0", "- ใช้เวลา 2 นาที 14 วินาที",
    ].join("\n"));
  });

  test("a card is `done` only if it ended done: done in the run but sent back later is not listed", () => {
    seq = 0;
    const text = buildReport(base({ cards: [card(1, "A", "todo")], events: [ev("card.status_set", { cardId: "c1", status: "done" }), ev("card.status_set", { cardId: "c1", status: "todo" })] }));
    expect(text.split("\n").slice(0, 2)).toEqual(["เสร็จแล้ว", "- ไม่มี"]);
  });

  test("failed and interrupted hops are problems too, in hop order, with their notes", () => {
    const text = buildReport(base({ hops: [hop(1, "c1", "interrupted", { note: "ถูกขัดจังหวะเพราะตัวรันเริ่มใหม่" }), hop(2, "c1", "failed", { note: "ก้าวนี้ไม่ได้ทิ้งผลงานไว้ · exit 1" }), hop(3, "c2", "commented")], cards: [card(1, "A", "todo"), card(2, "B", "todo")] }));
    const lines = text.split("\n");
    expect(lines.slice(lines.indexOf("ปัญหา") + 1, lines.indexOf("ค่าใช้จ่าย"))).toEqual([
      "- ก้าว 1 (#1) ถูกขัดจังหวะเพราะตัวรันเริ่มใหม่", // the note already begins with the word
      "- ก้าว 2 (#1) ไม่สำเร็จ: ก้าวนี้ไม่ได้ทิ้งผลงานไว้ · exit 1",
      "- เหตุที่จบรอบ: ใช้งบครบแล้ว",
    ]);
  });

  test("a hop still running when the run is closed (a stop that does not wait for it) is shown as still going, not hidden", () => {
    const text = buildReport(base({ hops: [hop(1, "c1", null, { endedAt: null })], cards: [card(1, "A", "todo")] }));
    expect(text).toContain("- ก้าว 1 (#1) ยังทำอยู่\n");
  });

  test("a hop with no note prints without the colon part", () => {
    const text = buildReport(base({ hops: [hop(1, "c1", "failed")], cards: [card(1, "A", "todo")] }));
    expect(text).toContain("- ก้าว 1 (#1) ไม่สำเร็จ\n");
  });

  test("hops are numbered by their order in the run, whatever order the API gave them in", () => {
    const text = buildReport(base({ hops: [{ ...hop(2, "c2", "failed"), id: "h-b" }, { ...hop(1, "c1", "failed"), id: "h-a" }], cards: [card(1, "A", "todo"), card(2, "B", "todo")] }));
    expect(text.indexOf("ก้าว 1 (#1)")).toBeLessThan(text.indexOf("ก้าว 2 (#2)"));
  });

  test("the report stays under the API's 20000-character limit", () => {
    const cards = Array.from({ length: 800 }, (_, i) => card(i + 1, `การ์ดที่มีชื่อยาวมากมาย ${i}`, "done"));
    seq = 0;
    const events = cards.map((c) => ev("card.status_set", { cardId: c.id, status: "done" }));
    const text = buildReport(base({ cards, events }));
    expect(text.length).toBeLessThanOrEqual(20000);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("one vocabulary with the screens (REQ-012 l.49): Thai statuses, never the code", () => {
  const STATUS_WORDS = { todo: "รอทำ", doing: "กำลังทำ", review: "รอตรวจ", done: "เสร็จ", stuck: "ติดอยู่" } as const;
  test("every status a worker can set is printed with its board-column word", () => {
    seq = 0;
    const cards = [card(1, "ก", "todo"), card(2, "ข", "doing"), card(3, "ค", "review"), card(4, "ง", "done"), card(5, "จ", "stuck")];
    const events = (["todo", "doing", "review", "done", "stuck"] as const).map((st, k) => ev("card.status_set", { cardId: `c${k + 1}`, status: st }));
    const text = buildReport(base({ cards, events }));
    for (const [code, word] of Object.entries(STATUS_WORDS)) expect(text).toContain(`เปลี่ยน #${Object.keys(STATUS_WORDS).indexOf(code) + 1} เป็น ${word}`);
  });
  test("NO status code appears anywhere in a report (not as a word, not in a line)", () => {
    seq = 0;
    const cards = [card(1, "ก", "done"), card(2, "ข", "stuck"), card(3, "ค", "review")];
    const events = ["todo", "doing", "review", "done", "stuck"].flatMap((st, k) => [ev("card.status_set", { cardId: `c${(k % 3) + 1}`, status: st })]);
    const text = buildReport(base({ cards, events, hops: [hop(1, "c1", "failed"), hop(2, "c2", "stopped", { note: "หยุดไว้: x" }), hop(3, "c3", "interrupted"), hop(4, "c1", "asked")] }));
    expect(text).not.toMatch(/\b(todo|doing|review|done|stuck)\b/);
    expect(text).not.toMatch(/\b(commented|handed_off|asked|failed|stopped|interrupted)\b/); // hop outcome codes either
  });
  test("an unknown status is printed as a plain 'ไม่ทราบสถานะ', never as a raw code", () => {
    seq = 0;
    const text = buildReport(base({ cards: [card(1, "ก", "todo")], events: [ev("card.status_set", { cardId: "c1", status: "archived" })] }));
    expect(text).toContain("เปลี่ยน #1 เป็น ไม่ทราบสถานะ");
    expect(text).not.toContain("archived");
  });
});
