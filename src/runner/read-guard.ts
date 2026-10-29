// The read guard (TASK-C-042 Part A, REQ-015 UP-3) and, since TASK-112/118, the Bash policy hook: one PreToolUse hook for Read | Glob | Grep | Bash, owned by the runner.
// Claude's own `permissions.blockReadsOutsideWorkingDirectories` stalls claude at start-up (TASK-C-042 probe table), so the file tools are fenced here instead: every path a
// call names must resolve, by REAL path, to a readable folder (the project's roots + the hop's private folder), or the hook exits 2 with a one-line reason and the tool is refused.
// Bash is judged by bash-policy.ts (SPEC-108): what a worker may run, in which folders. It FAILS CLOSED.
// Every refusal line starts `caw-refused <code>: ` (SPEC-108 D3) — hop.ts reads the code and the quoted detail back out of the stream to write the hop's note.
//   usage (as a hook):   bun read-guard.ts '<JSON list of readable dirs>' ['<JSON list of read-only dirs>' ['<JSON list of host:port of I-Space's own servers>']]   with the hook's JSON on stdin
import { isAbsolute } from "node:path";
import { type Code, type Refusal, absolute, inside, judgeBash, realOf } from "./bash-policy";

type Payload = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };

/** the part of a glob that is a plain folder: up to (not including) the path segment holding the first glob character */
function staticPrefix(pattern: string): string {
  const cut = pattern.search(/[*?[{]/);
  if (cut < 0) return pattern;
  const head = pattern.slice(0, cut);
  const slash = head.lastIndexOf("/");
  return slash <= 0 ? "/" : head.slice(0, slash);
}

/** the paths one call names; null = the call names none we understand */
function pathsOf(tool: string, input: Record<string, unknown>, cwd: string): string[] | null {
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  if (tool === "Read") { const f = str(input.file_path); return f ? [absolute(f, cwd)] : null; }
  if (tool === "Glob" || tool === "Grep") {
    const out = [absolute(str(input.path) ?? cwd, cwd)];                        // no path = the cwd
    const pattern = tool === "Glob" ? str(input.pattern) : str(input.glob);      // a Grep `pattern` is a regex, not a path
    if (pattern && (isAbsolute(pattern) || pattern.startsWith("~") || pattern.includes(".."))) out.push(absolute(staticPrefix(pattern), isAbsolute(pattern) ? "/" : (out[0] as string)));
    return out;
  }
  return [];                                                                     // not a file tool: not our business
}

/** What the model reads when a Bash command is refused: the code, then English that says what to do instead. The detail is always the FIRST double-quoted piece — hop.ts takes it back out. */
const ENGLISH: Record<Code, (detail: string) => string> = {
  shell_feature: (d) => `"${d}" cannot be used in a command here — run plain commands, chained with && || ; or | only`,
  not_allowed: (d) => `"${d}" is not a command a worker may run here — use bun, node, git (read) or file commands`,
  git_write: (d) => `"${d}" is not allowed — a worker reads git (status, log, diff, show, ls-files, blame, rev-parse) and never writes it`,
  inline_code: (d) => `"${d}" runs code from the command line — write the code to a file first, then run the file`,
  network: (d) => `"${d}" reaches the network — only 127.0.0.1, localhost and [::1] are allowed (and the package registry for bun install / add)`,
  outside: (d) => `"${d}" is outside the project's folders — a worker reads only inside them`,
  read_only: (d) => `"${d}" is in a read-only folder — a worker cannot write there`,
  api: (d) => `"${d}" is one of I-Space's own servers — a worker acts on CAW only through its MCP tools`,
};
const line = (r: Refusal) => `caw-refused ${r.code}: ${ENGLISH[r.code](r.detail.replace(/"/g, "'"))}`;

/** null = allowed; otherwise the one-line reason (`caw-refused <code>: …`) and the tool is refused. `readOnly` = folders (⊆ readable) a Bash command may not write to. */
export function guard(payload: Payload, readable: readonly string[], readOnly: readonly string[] = [], serverPorts: readonly string[] = []): string | null {
  const outside = (m: string) => `caw-refused outside: read guard: ${m}`;
  if (!payload || typeof payload !== "object") return outside("the hook payload is not an object — refused");
  const tool = String(payload.tool_name ?? "");
  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();
  if (tool === "Bash") {
    const command = payload.tool_input?.command;
    if (typeof command !== "string" || command.trim() === "") return "caw-refused not_allowed: Bash names no command — send one command";
    const r = judgeBash(command, cwd, [...readable], [...readOnly], [...serverPorts]);
    return r === null ? null : line(r);
  }
  const paths = pathsOf(tool, payload.tool_input ?? {}, cwd);
  if (paths === null) return outside(`${tool} names no file path — refused`);
  const dirs = readable.map((d) => realOf(d));
  for (const p of paths) {
    const real = realOf(p);
    if (!dirs.some((d) => inside(real, d))) return outside(`${real} is outside the project's folders — a worker reads only inside them`);
  }
  return null;
}

/** the hook as a pure function of its arguments and stdin: exit code and stderr text. Arg 1 = readable folders (required); arg 2 = read-only folders (optional, missing = none). */
export function runGuardCli(args: readonly string[], stdin: string): { code: number; stderr: string } {
  const refuse = (m: string) => ({ code: 2, stderr: `caw-refused outside: read guard: ${m}` });
  const list = (raw: string | undefined): string[] | null => {
    try { const v = JSON.parse(raw ?? ""); return Array.isArray(v) && v.every((d) => typeof d === "string" && d !== "") ? (v as string[]) : null; } catch { return null; }
  };
  const readable = list(args[0]);
  if (readable === null) return refuse("the readable-folders argument is missing or not JSON — refused");
  if (readable.length === 0) return refuse("no readable folders given — refused");
  let readOnly: string[] = [];
  if (args[1] !== undefined) {
    const ro = list(args[1]);
    if (ro === null) return refuse("the read-only-folders argument is not a JSON list of folders — refused");
    readOnly = ro;
  }
  let serverPorts: string[] = [];
  if (args[2] !== undefined) {
    const sp = list(args[2]);
    if (sp === null) return refuse("the server-ports argument is not a JSON list of host:port strings — refused");
    serverPorts = sp;
  }
  let payload: Payload;
  try { payload = JSON.parse(stdin); } catch { return refuse("the hook input is not JSON — refused"); }
  const why = guard(payload, readable, readOnly, serverPorts);
  return why === null ? { code: 0, stderr: "" } : { code: 2, stderr: why };
}

if (import.meta.main) {
  const stdin = await Bun.stdin.text();
  const r = runGuardCli(process.argv.slice(2), stdin);
  if (r.stderr) console.error(r.stderr);
  process.exit(r.code);
}
