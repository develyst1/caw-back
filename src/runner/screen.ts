// What a hop's CLI "screen" shows, for the read-only view of a worker (REQ-104, SPEC-103 § The runner). The runner already reads the child's stream-json
// line by line (hop.ts); this turns each line into the few text lines a person would see, takes secrets out, and sends them to the API in short batches.
// Nothing here may change a hop's outcome: the sender never throws, never waits for the API on the hop's path, and drops what it cannot send.
import { redact } from "./redact";

export const MAX_TEXT = 2000;
const SUMMARY_MAX = 200;

type Json = Record<string, any>;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** `Bash` → its command, `Read` / `Edit` / `Write` → their file_path, anything else → compact JSON (≤ 200 chars) */
function inputSummary(tool: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Json;
  if (tool === "Bash" && typeof o.command === "string") return cut(oneLine(o.command), SUMMARY_MAX);
  if ((tool === "Read" || tool === "Edit" || tool === "Write") && typeof o.file_path === "string") return cut(oneLine(o.file_path), SUMMARY_MAX);
  return cut(JSON.stringify(input ?? {}), SUMMARY_MAX);
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("") : "";

/** One stream-json line → the lines a person would see on the CLI screen. Anything unknown, or not JSON, → nothing (a newer CLI's new types are safe, not an error). */
export function screenLines(streamLine: string): string[] {
  let msg: Json;
  try { msg = JSON.parse(streamLine); } catch { return []; }
  if (msg === null || typeof msg !== "object") return [];
  const out: string[] = [];
  if (msg.type === "system" && msg.subtype === "init") out.push(`● session ${typeof msg.model === "string" ? msg.model : "?"}`);
  else if (msg.type === "result") out.push(`■ ${typeof msg.subtype === "string" ? msg.subtype : "?"} · turns ${typeof msg.num_turns === "number" ? msg.num_turns : "?"}`);
  else if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content as Json[]) {
      if (b?.type === "text" && typeof b.text === "string") { if (b.text.trim() !== "") out.push(...b.text.replace(/\s+$/, "").split(/\r?\n/)); }
      else if (b?.type === "tool_use" && typeof b.name === "string") out.push(`▸ ${b.name.replace(/^mcp__caw__/, "")} ${inputSummary(b.name.replace(/^mcp__caw__/, ""), b.input)}`.trimEnd());
    }
  } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content as Json[]) if (b?.type === "tool_result" && b.is_error === true) out.push(`✗ ${cut(oneLine(textOf(b.content)), 200)}`);
  }
  return out.map((l) => cut(l, MAX_TEXT));
}

// ---------- redaction ----------

/** secrets that carry their own shape: whatever they are called, they are never shown */
const BARE_KEYS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, // a JWT
];

/** `redact()` (URL credentials, `token=` forms, Bearer) plus the bare key shapes plus every value in `secrets`, matched exactly, longest first. */
export function liveRedact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of [...secrets].filter((v) => v !== "").sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
  out = redact(out);
  for (const re of BARE_KEYS) out = out.replace(re, "***");
  return out;
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASS|DATABASE_URL/i;
const MIN_SECRET = 6;

/** The value of every env key whose NAME looks like a secret, when it is at least 6 characters. Built once, at runner start (Bun has loaded the repo's .env into the env).
 *  Paths and plain URLs such as CAW_WORKSPACE_ROOT are not secrets and stay readable on the screen. */
export function secretValues(env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(env)) if (typeof v === "string" && v.length >= MIN_SECRET && SECRET_NAME.test(k)) out.add(v);
  return [...out];
}

// ---------- the sender ----------

export type ScreenEntry = { seq: number; at: string; kind: "line" | "gap" | "truncated"; text: string; gapSeconds?: number };
export type ScreenSenderOptions = {
  /** sends one batch; a rejection means "the API did not take it" */
  post: (hopId: string, entries: ScreenEntry[]) => Promise<unknown>;
  hopId: string;
  now: () => Date;
  flushMs?: number; maxBatch?: number; maxLines?: number;
  /** a request that has not answered after this long counts as failed */
  postTimeoutMs?: number;
  /** how long `close()` may wait */
  closeMs?: number;
  /** runs `fn` every `ms` and returns the function that stops it (default: setInterval) — tests drive the flush by hand */
  every?: (fn: () => void, ms: number) => () => void;
  log: (line: string) => void;
};

const realEvery = (fn: () => void, ms: number) => {
  const t = setInterval(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
};

export function createScreenSender(o: ScreenSenderOptions): { push(text: string): void; close(): Promise<void> } {
  const { post, hopId, now, log } = o;
  const flushMs = o.flushMs ?? 1000, maxBatch = o.maxBatch ?? 200, maxLines = o.maxLines ?? 5000, postTimeoutMs = o.postTimeoutMs ?? 10_000, closeMs = o.closeMs ?? 3000;
  let seq = 0, pushed = 0;
  let queue: ScreenEntry[] = [];
  let inFlight: Promise<void> | null = null;
  let downSince: number | null = null; // the time of the first failed POST
  let truncated = false, truncatedSent = false, closed = false;
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const at = () => now().toISOString();

  /** one request, bounded in time; resolves to whether the API took it. Never rejects. */
  const send = async (entries: ScreenEntry[]): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([post(hopId, entries), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer in ${postTimeoutMs} ms`)), postTimeoutMs); })]);
      return true;
    } catch (e) {
      if (downSince === null) log(`hop ${hopId}: screen output not sent (${message(e)}) — lines are dropped until the API answers`);
      return false;
    } finally { clearTimeout(timer); }
  };

  const queueTruncated = () => {
    if (truncatedSent) return;
    truncatedSent = true;
    queue.push({ seq: seq++, at: at(), kind: "truncated", text: "" });
  };

  /** one flush: a batch when up, a probe (a `gap` entry) when down. At most one request in flight. */
  const flush = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (downSince === null && queue.length === 0) return Promise.resolve();
    const run = (async () => {
      if (downSince !== null) {
        const seconds = Math.max(1, Math.ceil((now().getTime() - downSince) / 1000));
        if (await send([{ seq: seq++, at: at(), kind: "gap", text: "", gapSeconds: seconds }])) {
          log(`hop ${hopId}: screen output is flowing again after ${seconds} s`);
          downSince = null;
          if (truncated) queueTruncated(); // the cut-off point came while the API was down: say it now
        }
        return;
      }
      const batch = queue.splice(0, maxBatch);
      if (!(await send(batch))) { downSince = now().getTime(); queue = []; }
    })().finally(() => { inFlight = null; });
    inFlight = run;
    return run;
  };

  const stop = (o.every ?? realEvery)(() => { void flush(); }, flushMs);

  return {
    push(text) {
      try {
        if (closed || truncatedSent) return;
        pushed++;
        if (pushed > maxLines) {
          truncated = true;
          if (downSince === null) queueTruncated();
          return;
        }
        const n = seq++; // a dropped line still uses its seq: the hole is the sign
        if (downSince !== null) return;
        queue.push({ seq: n, at: at(), kind: "line", text: cut(text, MAX_TEXT) });
      } catch (e) { log(`hop ${hopId}: screen push failed: ${message(e)}`); }
    },
    async close() {
      try {
        stop();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<void>((res) => { timer = setTimeout(res, closeMs); });
        const drain = async () => {
          for (;;) {
            await inFlight;
            if (closed || downSince !== null || queue.length === 0) return;
            await flush();
          }
        };
        await Promise.race([drain(), deadline]);
        clearTimeout(timer);
        closed = true; // whatever the race left behind stops here: no new request after close
      } catch (e) { log(`hop ${hopId}: screen close failed: ${message(e)}`); }
    },
  };
}
