// The read guard (TASK-C-042 Part A, REQ-015 UP-3): a PreToolUse hook for Read | Glob | Grep, owned by the runner.
// Claude's own `permissions.blockReadsOutsideWorkingDirectories` stalls claude at start-up when the Bash sandbox is on (TASK-C-042 probe table), so the file tools
// are fenced here instead: every path a call names must resolve, by REAL path, to a readable folder (the project's roots + the hop's private folder), or the
// hook exits 2 with a one-line reason and the tool is refused. It runs outside the sandbox (docs), so it can read what it needs. It FAILS CLOSED.
//   usage (as a hook):   bun read-guard.ts '<JSON list of readable dirs>'   with the hook's JSON on stdin
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

type Payload = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };

/** the real path of `p` when it exists; otherwise the real path of its nearest existing ancestor plus the rest — so a file about to be created is judged by where it would land */
function realOf(p: string): string {
  const abs = normalize(p);
  let cur = abs;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return abs;
    rest.unshift(cur.slice(up.length).replace(/^[\\/]+/, ""));
    cur = up;
  }
  try { return join(realpathSync(cur), ...rest); } catch { return abs; }
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** `~` and `~/x` mean the home directory; a relative path is against the cwd; `..` is resolved before anything else */
function absolute(p: string, cwd: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

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

/** null = allowed; otherwise the one-line reason (and the tool is refused) */
export function guard(payload: Payload, readable: readonly string[]): string | null {
  if (!payload || typeof payload !== "object") return "read guard: the hook payload is not an object — refused";
  const tool = String(payload.tool_name ?? "");
  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();
  const paths = pathsOf(tool, payload.tool_input ?? {}, cwd);
  if (paths === null) return `read guard: ${tool} names no file path — refused`;
  const dirs = readable.map((d) => realOf(d));
  for (const p of paths) {
    const real = realOf(p);
    if (!dirs.some((d) => inside(real, d))) return `read guard: ${real} is outside the project's folders — a worker reads only inside them`;
  }
  return null;
}

/** the hook as a pure function of its arguments and stdin: exit code and stderr text */
export function runGuardCli(args: readonly string[], stdin: string): { code: number; stderr: string } {
  const refuse = (m: string) => ({ code: 2, stderr: m });
  let dirs: unknown;
  try { dirs = JSON.parse(args[0] ?? ""); } catch { return refuse("read guard: the readable-folders argument is missing or not JSON — refused"); }
  if (!Array.isArray(dirs) || dirs.length === 0 || dirs.some((d) => typeof d !== "string" || d === "")) return refuse("read guard: no readable folders given — refused");
  let payload: Payload;
  try { payload = JSON.parse(stdin); } catch { return refuse("read guard: the hook input is not JSON — refused"); }
  const why = guard(payload, dirs as string[]);
  return why === null ? { code: 0, stderr: "" } : refuse(why);
}

if (import.meta.main) {
  const stdin = await Bun.stdin.text();
  const r = runGuardCli(process.argv.slice(2), stdin);
  if (r.stderr) console.error(r.stderr);
  process.exit(r.code);
}
