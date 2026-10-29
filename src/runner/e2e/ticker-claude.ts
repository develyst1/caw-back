// A stand-in for `claude -p` for the live-view check (REQ-104, SPEC-103 § Dev script) — NOT used by the runner, only started by it as CLAUDE_BIN (through the
// small shell wrapper live-view.ts writes). It prints stream-json like the real CLI: an `init`, then one assistant text line per second for TICKS (default 60),
// then it moves its card to review and comments on it through the API as that worker (so the hop ends `commented`), and prints a `result`.
// Tick 5 carries `sk-test-` + 24 letters and the value of LIVE_VIEW_SECRET — the screen must show *** for both. No Claude usage.
// The runner gives its child only PATH, HOME … (hop.ts childEnv), so TICKS and LIVE_VIEW_SECRET are written into the wrapper text by live-view.ts, not inherited.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
const cardId = /Your card is (\S+)/.exec(value("-p"))?.[1];
if (!cardId) { console.error("ticker-claude: no card id in the prompt (this stub works a card hop only)"); process.exit(2); }
const mcp = JSON.parse(readFileSync(value("--mcp-config"), "utf8")).mcpServers.caw.env as { CAW_API_URL: string; CAW_WORKER_ID: string; CAW_HOP_ID?: string };
const TICKS = Number(process.env.TICKS || 60);
const SECRET = process.env.LIVE_VIEW_SECRET ?? "";

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${mcp.CAW_API_URL}${path}`, {
    method, headers: { "x-caw-actor": `worker:${mcp.CAW_WORKER_ID}`, ...(mcp.CAW_HOP_ID ? { "x-caw-hop": mcp.CAW_HOP_ID } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) { console.error(`ticker-claude: ${method} ${path}: ${res.status} ${JSON.stringify(json)}`); process.exit(3); }
  return json as any;
}
const say = (o: object) => console.log(JSON.stringify(o));
const text = (t: string) => say({ type: "assistant", message: { id: "msg_ticker", role: "assistant", content: [{ type: "text", text: t }] } });

say({ type: "system", subtype: "init", model: "ticker-stub", session_id: "ticker", tools: [], mcp_servers: [] });
for (let i = 1; i <= TICKS; i++) {
  text(i === 5 ? `tick 5 of ${TICKS} — key sk-test-${"abcdefghijklmnopqrstuvwx"} and the secret ${SECRET}` : `tick ${i} of ${TICKS}`);
  await new Promise((r) => setTimeout(r, 1000));
}
await call("PATCH", `/v1/cards/${cardId}/status`, { status: "review" });
await call("POST", `/v1/cards/${cardId}/comments`, { text: "done (ticker stub)" }); // the last write → outcome `commented`
say({ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
