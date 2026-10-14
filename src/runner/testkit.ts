// Test-only helpers for src/runner/*.test.ts (imported by tests, never by the runner itself).
import { readFileSync } from "node:fs";
import type { Call } from "../../test/helpers/api";
import type { Child } from "./hop";

/** the recorded spike stream `name` (src/runner/fixtures/<name>.stream.jsonl), one JSON object per element */
export const fixture = (name: string): string[] =>
  readFileSync(new URL(`./fixtures/${name}.stream.jsonl`, import.meta.url).pathname, "utf8").split("\n").filter(Boolean);

export type FakeChild = Child & { killed: boolean; signals: string[]; release(): void };

/** A fake `claude`: emits `lines` (cut into odd-sized chunks, to prove line buffering), then closes — or, with `hang`, stays open
 *  until `kill()` or `release()`. `before` runs first: what the real child would do through MCP, the test does through the API.
 *  `ignoreTerm`: only SIGKILL ends it (a child that shrugs off SIGTERM). `fail`: the stdout pipe errors after `before`. */
export function fakeChild(o: { lines?: string[]; hang?: boolean; before?: () => Promise<void>; ignoreTerm?: boolean; fail?: Error; exitCode?: number; pid?: number } = {}): FakeChild {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let done!: (code: number) => void;
  const exited = new Promise<number>((r) => { done = r; });
  const close = (code: number) => { try { controller.close(); } catch { /* already closed */ } done(code); };
  const child: FakeChild = {
    killed: false,
    signals: [],
    pid: o.pid,
    exited,
    kill(signal = "SIGTERM") {
      child.killed = true;
      child.signals.push(signal);
      if (o.ignoreTerm && signal !== "SIGKILL") return;
      close(signal === "SIGKILL" ? 137 : 143);
    },
    release() { close(0); },
    stderrText: async () => "",
    stdout: new ReadableStream<Uint8Array>({
      async start(c) {
        controller = c;
        await o.before?.();
        if (o.fail) { c.error(o.fail); return; }
        const bytes = new TextEncoder().encode((o.lines ?? []).map((l) => `${l}\n`).join(""));
        for (let i = 0; i < bytes.length; i += 97) c.enqueue(bytes.slice(i, i + 97));
        if (!o.hang) close(o.exitCode ?? 0);
      },
    }),
  };
  return child;
}

/** The recorded `ok` stream with its rate_limit_event's status changed to "rejected". **THE VALUE "rejected" IS INVENTED FOR THE TEST** — the
 *  real value when a subscription limit is hit was never observed or documented (TASK-C-029 § 4); the runner treats any status but "allowed" as the limit. */
export const limitFixture = (): string[] =>
  fixture("ok").map((l) => { const m = JSON.parse(l); if (m.type === "rate_limit_event") m.rate_limit_info.status = "rejected"; return JSON.stringify(m); });

/** Contract v1.5 (D-054): a `worker:` write on a card must carry `X-CAW-Hop` = that worker's RUNNING hop on the card. The real MCP server sends it from
 *  CAW_HOP_ID; a test that plays the worker through `call` gets it here — found from the store, as the runner would have set it. */
export function hopAware(call: Call): Call {
  return async (method, path, body, actor = "operator", headers = {}) => {
    const m = /^\/v1\/cards\/([^/]+)/.exec(path);
    if (typeof actor === "string" && actor.startsWith("worker:") && m && !headers["x-caw-hop"]) {
      const card = (await call("GET", `/v1/cards/${m[1]}`)).json;
      const hops = (await call("GET", `/v1/projects/${card.projectId}/hops?limit=200`)).json.hops as { id: string; cardId: string; workerId: string; endedAt: string | null }[];
      const running = hops.find((h) => h.cardId === card.id && h.workerId === actor.slice("worker:".length) && h.endedAt === null);
      if (running) headers = { ...headers, "x-caw-hop": running.id };
    }
    return call(method, path, body, actor, headers);
  };
}
