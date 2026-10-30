// A stand-in for an OPEN `claude -p --input-format stream-json` worker (REQ-122, SPEC-120 D1) — NOT used by the runner, only started by it as CLAUDE_BIN (through a small shell wrapper).
// It reads one stream-json user message per stdin line and, for each, does what fake-claude.ts does for a card: reads its card, then (by a directive in the card's todo) moves it to review
// and comments — straight against the API as that worker, with the hop id read from CAW_HOP_FILE (named in --mcp-config's env) PER MESSAGE, as the real MCP server does. Then it prints the
// recorded `ok` stream (it ends in a `result`) and waits for the next line; it exits 0 on stdin EOF. No Claude usage.
// A chat hop (no `--input-format`) is the one-shot fake-claude's job: this file hands over to it.
//   Directives in the card's todo, for QA: `FAKE:die` exits 1 mid-task, before the `result` · `FAKE:slow` sleeps 3 s first · (as in fake-claude) `FAKE:ask`, `FAKE:done`, `FAKE:sleep=<ms>`.
// Every process writes `<pid> <task-count>` to stderr per task, so QA can count processes with `ps` and see how many tasks each served.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1] ?? "";

if (!args.includes("--input-format")) {
  await import("./fake-claude"); // runs as the one-shot stub, with the same argv
} else {
  const mcp = JSON.parse(readFileSync(value("--mcp-config"), "utf8")).mcpServers.caw.env as { CAW_API_URL: string; CAW_WORKER_ID: string; CAW_HOP_FILE?: string };
  const recorded = readFileSync(new URL("../fixtures/ok.stream.jsonl", import.meta.url).pathname, "utf8").split("\n").filter(Boolean);
  /** the running hop's id: the file's content right now (empty or missing = none), read on every call like the real MCP server does */
  const hopId = () => { try { return mcp.CAW_HOP_FILE ? readFileSync(mcp.CAW_HOP_FILE, "utf8").trim() : ""; } catch { return ""; } };

  async function call(method: string, path: string, body?: unknown) {
    const hop = hopId();
    const res = await fetch(`${mcp.CAW_API_URL}${path}`, {
      method, headers: { "x-caw-actor": `worker:${mcp.CAW_WORKER_ID}`, ...(hop ? { "x-caw-hop": hop } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) { console.error(`open-claude: ${method} ${path}: ${res.status} ${JSON.stringify(json)}`); process.exit(3); }
    return json as any;
  }

  let tasks = 0;
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const msg = JSON.parse(line);
    const prompt: string = typeof msg.message?.content === "string" ? msg.message.content : JSON.stringify(msg.message?.content ?? "");
    const cardId = /Your card is (\S+)/.exec(prompt)?.[1];
    if (!cardId) { console.error("open-claude: no card id in the task"); process.exit(2); }
    tasks++;
    console.error(`${process.pid} ${tasks}`);
    const todo: string = (await call("GET", `/v1/cards/${cardId}`)).todo;
    if (todo.includes("FAKE:die")) { console.log(recorded[0]); process.exit(1); } // mid-task, before any `result`
    if (todo.includes("FAKE:slow")) await new Promise((r) => setTimeout(r, 3000));
    const sleep = /FAKE:sleep=(\d+)/.exec(todo)?.[1];
    if (sleep) await new Promise((r) => setTimeout(r, Number(sleep)));
    if (todo.includes("FAKE:ask")) {
      await call("POST", `/v1/cards/${cardId}/question`, { text: "which way?", proposedDefault: "the first", cases: ["either"] });
    } else {
      await call("PATCH", `/v1/cards/${cardId}/status`, { status: todo.includes("FAKE:done") ? "done" : "review" });
      await call("POST", `/v1/cards/${cardId}/comments`, { text: "done (open fake worker)" }); // last write → outcome `commented`
    }
    for (const l of recorded) console.log(l); // ends in a `result`: the task is over, the process waits for the next line
  }
}
