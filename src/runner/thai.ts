// Thai text for times, for the run report and the limit note. Month letters are spelled out here, not taken from ICU, so the text does not
// depend on the machine's locale data.
const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

const bangkok = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: String(p.hour).padStart(2, "0"), mm: String(p.minute).padStart(2, "0") };
};

/** `resetsAt` (unix seconds) as Asia/Bangkok `HH:mm`, with the date first when it is not today there: `15 ต.ค. 10:05`. */
export function formatReset(resetsAtSeconds: number, now: Date = new Date()): string {
  const t = bangkok(new Date(resetsAtSeconds * 1000));
  const n = bangkok(now);
  const sameDay = t.y === n.y && t.m === n.m && t.d === n.d;
  return sameDay ? `${t.hh}:${t.mm}` : `${t.d} ${MONTHS[t.m - 1]} ${t.hh}:${t.mm}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const parts = [h > 0 ? `${h} ชั่วโมง` : "", m > 0 ? `${m} นาที` : "", s > 0 ? `${s} วินาที` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : "0 วินาที";
}
