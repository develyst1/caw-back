// Parse `claude -p --output-format stream-json --verbose` — one JSON object per line. Pure: no I/O, no clock.
// The shapes below are the ones TASK-C-029 recorded from a real `claude` 2.1.287 (src/runner/fixtures/*.jsonl); nothing is guessed.
//  - a hook block      → a `user` message whose tool_result is_error text starts `PreToolUse:<Tool> hook error:`
//  - a permission deny → `{type:"system", subtype:"permission_denied", tool_name, tool_use_id, message}`
//  - both are ALSO listed in the final `result.permission_denials[]`, so that list only adds what was not already seen
//  - a run with blocks still ends `subtype:"success"`
//  - the limit signal   → `rate_limit_event.rate_limit_info.{status, resetsAt}`; the value when it is hit was never observed,
//    so any status other than "allowed" / "allowed_warning" counts (SPEC-C-003 § 8; `allowed_warning` is in the CLI binary's strings — inferred, not documented).
export type Block = { kind: "hook" | "permission"; tool: string; action: string; text: string };
export type Limit = { status: string; resetsAt: number | null };
export type Init = { tools: number; mcpServers: string[]; plugins: string[]; model: string; permissionMode: string; apiKeySource: string };
export type Usage = { input: number; cacheCreation: number; cacheRead: number; output: number };
export type StreamSummary = {
  tokensIn: number | null; tokensOut: number | null; isError: boolean | null; subtype: string | null; blocks: Block[]; limit: Limit | null;
  /** what the session started with (the `system/init` message) and the four token numbers apart — for the log, not the store */
  init: Init | null; usage: Usage | null;
};

type Json = Record<string, any>;
import { redact } from "./redact";

/** statuses that mean "go on"; anything else, including a value nobody has seen yet, is the limit */
const NOT_HIT = new Set(["allowed", "allowed_warning"]);
const HOOK_BLOCK = /^PreToolUse:(\S+) hook error:/;

/** "Bash: git push origin HEAD" — what the worker tried, for the stop note. */
function describe(tool: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Json;
  const text = [o.command, o.file_path, o.path, o.url].find((v) => typeof v === "string") ?? Object.values(o).find((v) => typeof v === "string") ?? "";
  const one = redact(String(text).replace(/\s+/g, " ").trim());
  return one === "" ? tool : `${tool}: ${one.length > 160 ? `${one.slice(0, 157)}...` : one}`;
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);
const toUsage = (u: Json): Usage => ({ input: num(u.input_tokens), cacheCreation: num(u.cache_creation_input_tokens), cacheRead: num(u.cache_read_input_tokens), output: num(u.output_tokens) });

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("") : "";

export class StreamState {
  private uses = new Map<string, { tool: string; input: unknown }>();
  private seen = new Set<string>();
  private blocks: Block[] = [];
  private result: Json | null = null;
  /** set by the first `rate_limit_event` whose status is not "allowed" or "allowed_warning" */
  limit: Limit | null = null;
  private init: Init | null = null;
  private assistantUsage = new Map<string, Usage>(); // message id → the last usage seen for it (one message appears on several lines)

  /** lines that were not JSON at all, and lines whose valid JSON had a shape this parser did not expect — counted, so the hop can log them */
  unparsed = 0;
  faults = 0;

  /** Feed one line; returns the blocks that line added (usually none). Never throws: a bad line is counted, not lost silently. */
  feed(line: string): Block[] {
    try { return this.read(line); } catch { this.faults++; return []; }
  }

  private read(line: string): Block[] {
    if (line.trim() === "") return [];
    let m: Json;
    try { m = JSON.parse(line); } catch { this.unparsed++; return []; }
    if (!m || typeof m !== "object") return [];
    const added: Block[] = [];
    const add = (b: Block, id: string) => { this.seen.add(id); this.blocks.push(b); added.push(b); };

    if (m.type === "assistant") {
      for (const c of m.message?.content ?? []) if (c?.type === "tool_use" && typeof c.id === "string") this.uses.set(c.id, { tool: String(c.name), input: c.input });
      const u = m.message?.usage;
      if (u && typeof m.message?.id === "string") this.assistantUsage.set(m.message.id, toUsage(u));
    } else if (m.type === "user") {
      for (const c of m.message?.content ?? []) {
        if (c?.type !== "tool_result" || c.is_error !== true) continue;
        const text = textOf(c.content);
        const hit = HOOK_BLOCK.exec(text);
        if (!hit) continue;
        const use = this.uses.get(c.tool_use_id);
        add({ kind: "hook", tool: hit[1]!, action: describe(use?.tool ?? hit[1]!, use?.input), text }, String(c.tool_use_id));
      }
    } else if (m.type === "system" && m.subtype === "permission_denied") {
      const use = this.uses.get(m.tool_use_id);
      add({ kind: "permission", tool: String(m.tool_name), action: describe(String(m.tool_name), use?.input), text: String(m.message ?? "") }, String(m.tool_use_id));
    } else if (m.type === "system" && m.subtype === "init") {
      this.init = {
        tools: Array.isArray(m.tools) ? m.tools.length : 0,
        mcpServers: (Array.isArray(m.mcp_servers) ? m.mcp_servers : []).map((s: Json) => String(s?.name ?? s)),
        plugins: (Array.isArray(m.plugins) ? m.plugins : []).map((p: Json) => String(p?.name ?? p)),
        model: String(m.model ?? ""), permissionMode: String(m.permissionMode ?? ""), apiKeySource: String(m.apiKeySource ?? ""),
      };
    } else if (m.type === "rate_limit_event") {
      const info = m.rate_limit_info ?? {};
      if (typeof info.status === "string" && !NOT_HIT.has(info.status)) this.limit = { status: info.status, resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : null };
    } else if (m.type === "result") {
      this.result = m;
      for (const d of m.permission_denials ?? []) {
        if (this.seen.has(String(d.tool_use_id))) continue;
        add({ kind: "permission", tool: String(d.tool_name), action: describe(String(d.tool_name), d.tool_input), text: "permission denied" }, String(d.tool_use_id));
      }
    }
    return added;
  }

  summary(): StreamSummary {
    // The final `result` has the real totals. A hop the runner ends first has none: then the assistant messages' own usage, each distinct message
    // once. Input is exact (it matched the recorded result); output is a LOWER BOUND — an assistant line carries the count from when the message began.
    let usage: Usage | null = this.result?.usage ? toUsage(this.result.usage) : null;
    if (!usage && this.assistantUsage.size > 0) {
      usage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
      for (const m of this.assistantUsage.values()) { usage.input += m.input; usage.cacheCreation += m.cacheCreation; usage.cacheRead += m.cacheRead; usage.output += m.output; }
    }
    return {
      tokensIn: usage ? usage.input + usage.cacheCreation + usage.cacheRead : null,
      tokensOut: usage ? usage.output : null,
      isError: this.result ? this.result.is_error === true : null,
      subtype: typeof this.result?.subtype === "string" ? this.result.subtype : null,
      blocks: [...this.blocks],
      limit: this.limit,
      init: this.init,
      usage,
    };
  }
}

export function summarize(lines: Iterable<string>): StreamSummary {
  const st = new StreamState();
  for (const l of lines) st.feed(l);
  return st.summary();
}
