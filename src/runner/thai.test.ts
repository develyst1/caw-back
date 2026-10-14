import { describe, expect, test } from "bun:test";
import { formatDuration, formatReset } from "./thai";

const at = (iso: string) => Date.parse(iso) / 1000; // unix seconds, as rate_limit_info.resetsAt

describe("formatReset — Asia/Bangkok, HH:mm, plus the date when it is not today", () => {
  test("later today (Bangkok)", () => {
    expect(formatReset(at("2026-10-14T07:30:00Z"), new Date("2026-10-14T01:00:00Z"))).toBe("14:30");
  });
  test("another day: the date comes first, in Thai month letters", () => {
    expect(formatReset(at("2026-10-15T03:05:00Z"), new Date("2026-10-14T01:00:00Z"))).toBe("15 ต.ค. 10:05");
  });
  test("'today' is Bangkok's today, not UTC's: 18:30 UTC on the 14th is already the 15th in Bangkok", () => {
    expect(formatReset(at("2026-10-15T03:05:00Z"), new Date("2026-10-14T18:30:00Z"))).toBe("10:05");
  });
  test("midnight and single digits are padded", () => {
    expect(formatReset(at("2026-10-14T17:05:00Z"), new Date("2026-10-14T17:00:00Z"))).toBe("00:05");
  });
  test("all twelve month abbreviations exist", () => {
    const months = Array.from({ length: 12 }, (_, m) => formatReset(at(`2027-${String(m + 1).padStart(2, "0")}-20T05:00:00Z`), new Date("2026-01-01T00:00:00Z")).split(" ")[1]);
    expect(months).toEqual(["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]);
  });
});

describe("formatDuration — a run's length in Thai", () => {
  test.each([
    [0, "0 วินาที"], [45_000, "45 วินาที"], [60_000, "1 นาที"], [134_000, "2 นาที 14 วินาที"], [3_600_000, "1 ชั่วโมง"], [3_725_000, "1 ชั่วโมง 2 นาที 5 วินาที"],
  ])("%d ms → %s", (ms, text) => { expect(formatDuration(ms)).toBe(text); });
});
