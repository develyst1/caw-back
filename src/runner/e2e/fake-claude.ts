// A stand-in for `claude -p` for TASK-C-031's e2e checks — NOT used by the runner, only started by it as CLAUDE_BIN (through the small
// shell wrapper auto.ts writes). It does what a worker's turn does through MCP, but straight against the API as that worker:
// reads its card, then (by a directive in the card's todo) sleeps, asks the operator, or moves the card to review and comments.
// Then it prints a RECORDED stream (the spike's `ok` run) and exits 0. No Claude usage.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
const prompt = value("-p");
const cardId = /Your card is (\S+)/.exec(prompt)?.[1];
const chat = /message (\S+) in project (\S+)\./.exec(prompt); // the entry worker's CHAT hop (TASK-C-034): "The operator wrote message <id> in project <id>."
if (!cardId && !chat) { console.error("fake-claude: neither a card id nor a chat message in the prompt"); process.exit(2); }
const mcp = JSON.parse(readFileSync(value("--mcp-config"), "utf8")).mcpServers.caw.env as { CAW_API_URL: string; CAW_WORKER_ID: string; CAW_HOP_ID?: string };

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${mcp.CAW_API_URL}${path}`, {
    method, headers: { "x-caw-actor": `worker:${mcp.CAW_WORKER_ID}`, ...(mcp.CAW_HOP_ID ? { "x-caw-hop": mcp.CAW_HOP_ID } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) { console.error(`fake-claude: ${method} ${path}: ${res.status} ${JSON.stringify(json)}`); process.exit(3); }
  return json as any;
}

const recorded = readFileSync(new URL("../fixtures/ok.stream.jsonl", import.meta.url).pathname, "utf8").split("\n").filter(Boolean);
if (chat) {
  // What the entry worker does through the five chat tools, as API calls; the message text says which. By the directive in the operator's message:
  //   FAKE:propose → locate + proposals + reply ({n} งาน ใช้ประมาณ {h} ก้าว) · FAKE:amend → locate + amendments + reply (not-in-spec words + link)
  //   FAKE:questions → one reply with three questions, each with proposedDefault · anything else → a plain reply
  const [, messageId, projectId] = chat;
  const text: string = (await call("GET", `/v1/chat/${messageId}/context`)).message.text;
  const P = `/v1/projects/${projectId}`;
  if (text.includes("FAKE:propose")) {
    await call("POST", `${P}/locate`, { request: "ห้องใหญ่ต้องอนุมัติ" });
    const items = [2, 3].map((hops, i) => ({ title: `งานที่ ${i + 1}`, todo: "ตาม STEP-004", anchor: { key: "STEP-004", version: 1 }, workerId: mcp.CAW_WORKER_ID, dependsOn: i === 1 ? [0] : [], hops }));
    const proposal = await call("POST", `${P}/proposals`, { messageId, items });
    await call("POST", `/v1/chat/${messageId}/reply`, { text: `${items.length} งาน ใช้ประมาณ ${items.reduce((s, i) => s + i.hops, 0)} ก้าว`, proposalId: proposal.id });
  } else if (text.includes("FAKE:amend")) {
    await call("POST", `${P}/locate`, { request: "ระบบจ่ายเงินเดือน" });
    const amendment = await call("POST", `${P}/amendments`, { request: "ขอเพิ่มระบบจ่ายเงินเดือน" });
    await call("POST", `/v1/chat/${messageId}/reply`, { text: "เรื่องนี้ยังไม่มีใน spec — ส่งไปเพิ่มใน Blueprint แล้ว", amendment: { blueprintMessageId: String(amendment.id ?? "bp-msg") } });
  } else if (text.includes("FAKE:questions")) {
    await call("POST", `/v1/chat/${messageId}/reply`, {
      text: "ขอถาม 3 ข้อก่อนเริ่ม",
      questions: ["ใช้สีไหน", "ต้องรองรับมือถือไหม", "ให้ใครอนุมัติ"].map((t) => ({ text: t, proposedDefault: "ตามเดิม", cases: ["ใช่", "ไม่ใช่"] })),
    });
  } else {
    await call("POST", `/v1/chat/${messageId}/reply`, { text: "รับทราบ" });
  }
  for (const line of recorded) console.log(line);
  process.exit(0);
}
const todo: string = (await call("GET", `/v1/cards/${cardId}`)).todo;
if (todo.includes("FAKE:limit")) {
  // The recorded stream up to its rate_limit_event, with that event's status changed to "rejected" — **an INVENTED value** (the real one when a
  // subscription limit is hit was never observed, TASK-C-029 § 4) — then it hangs: the runner must stop it.
  for (const l of recorded.slice(0, 14)) { const m = JSON.parse(l); if (m.type === "rate_limit_event") m.rate_limit_info.status = "rejected"; console.log(JSON.stringify(m)); }
  await new Promise((r) => setTimeout(r, 120_000));
  process.exit(0);
}
if (todo.includes("FAKE:block")) {
  // what claude prints when a guard hook blocks `git push` (the shape TASK-C-029 recorded), then it hangs: the runner must stop it.
  console.log(JSON.stringify({ type: "assistant", message: { id: "msg_fake_1", usage: { input_tokens: 10, cache_creation_input_tokens: 9277, cache_read_input_tokens: 24115, output_tokens: 1 }, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git push origin HEAD" } }] } })); // with the usage claude puts on an assistant line: a stopped hop has no `result`, so this is where its tokens come from
  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "PreToolUse:Bash hook error: [block-irreversible.sh]: Blocked by the overnight guard (git push)" }] } }));
  await new Promise((r) => setTimeout(r, 120_000));
  process.exit(0);
}
const sleep = /FAKE:sleep=(\d+)/.exec(todo)?.[1];
if (sleep) await new Promise((r) => setTimeout(r, Number(sleep)));
if (todo.includes("FAKE:ask")) {
  await call("POST", `/v1/cards/${cardId}/question`, { text: "which way?", proposedDefault: "the first", cases: ["either"] });
} else {
  await call("PATCH", `/v1/cards/${cardId}/status`, { status: todo.includes("FAKE:done") ? "done" : "review" });
  await call("POST", `/v1/cards/${cardId}/comments`, { text: "done (fake worker)" }); // last write → outcome `commented`
}
for (const line of recorded) console.log(line);
