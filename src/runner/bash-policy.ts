// What a worker may run in Bash (SPEC-108 D1/D2, REQ-111). claude allows `Bash` as a whole; THIS decides, in the read-guard hook, so the reason a worker sees is ours
// and the whole policy is testable without a real claude. Pure: the only I/O is `existsSync` / `realpathSync` to judge paths by where they really land.
// It judges WORDS, not processes (no sandbox, owner 13:41): code a worker writes and runs can still do what the OS lets it. It FAILS CLOSED: what it cannot parse is refused.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

export type Code = "shell_feature" | "not_allowed" | "git_write" | "inline_code" | "network" | "outside" | "read_only";
export type Refusal = { code: Code; detail: string };

// ---------- paths (shared with read-guard.ts) ----------

/** the real path of `p` when it exists; otherwise the real path of its nearest existing ancestor plus the rest — so a file about to be created is judged by where it would land */
export function realOf(p: string): string {
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

export const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** `~` and `~/x` mean the home directory; a relative path is against the cwd; `..` is resolved before anything else */
export function absolute(p: string, cwd: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** what in one word could name a path: the word; for an option (`-f/etc/x`, `--file=/etc/x`) also what follows its `=` and what starts at its first `/` or `~` */
export function candidates(word: string): string[] {
  const out = [word];
  if (word.startsWith("-")) {
    const eq = word.indexOf("=");
    if (eq >= 0) out.push(word.slice(eq + 1));
    const slash = word.indexOf("/");
    if (slash >= 0) out.push(word.slice(slash));
    const tilde = word.indexOf("~");
    if (tilde >= 0) out.push(word.slice(tilde));
  }
  return out;
}

// ---------- the tokenizer ----------

/** `g` = the word has an UNQUOTED glob character (`*` `?` `[`): only such a word is expanded by the shell, so only it can turn a `.?` segment into `..` (F3) */
type Tok = { k: "word"; v: string; g: boolean } | { k: "op"; v: string } | { k: "redir"; v: string } | { k: "dup" };
const label = (ch: string) => (ch === "\n" || ch === "\r" ? "newline" : ch);
/** refused outside single quotes: variable / command substitution, escapes, subshells, braces */
const NO_SHELL = new Set(["$", "`", "\\", "(", ")", "{", "}"]);
const shell = (detail: string): Refusal => ({ code: "shell_feature", detail });

/** quote-aware: single quotes are literal; double quotes group but `$` `` ` `` `\` `( ) { }` and newlines inside still refuse. Operators `&& || ; |`, redirects `> >> 2> 2>> &> <`
 *  and the dups `2>&1` `>&2` are tokens; a lone `&`, `<<`, a newline or anything in NO_SHELL → shell_feature. */
function tokenize(cmd: string): Tok[] | Refusal {
  const toks: Tok[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  let glob = false;
  const flush = () => { if (has || cur !== "") toks.push({ k: "word", v: cur, g: glob }); cur = ""; has = false; glob = false; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote === "'") { if (ch === "'") quote = null; else cur += ch; continue; }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (NO_SHELL.has(ch) || ch === "\n" || ch === "\r") return shell(label(ch));
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === "\n" || ch === "\r") return shell("newline");
    if (/\s/.test(ch)) { flush(); continue; }
    if (NO_SHELL.has(ch)) return shell(ch);
    if (ch === ";") { flush(); toks.push({ k: "op", v: ";" }); continue; }
    if (ch === "|") { flush(); if (cmd[i + 1] === "|") { i++; toks.push({ k: "op", v: "||" }); } else toks.push({ k: "op", v: "|" }); continue; }
    if (ch === "&") {
      if (cmd[i + 1] === "&") { flush(); i++; toks.push({ k: "op", v: "&&" }); continue; }
      if (cmd[i + 1] === ">") { flush(); i++; toks.push({ k: "redir", v: "&>" }); continue; }
      return shell("&"); // a lone & puts a command in the background
    }
    if (ch === "<") {
      if (cmd[i + 1] === "<") return shell("<<"); // heredoc / here-string
      flush(); toks.push({ k: "redir", v: "<" }); continue;
    }
    if (ch === ">") {
      const fd2 = cur === "2" && !has; // `2>` : the 2 is the file descriptor, not an argument
      if (fd2) cur = ""; else flush();
      if (cmd[i + 1] === "&") {
        const want = fd2 ? "1" : "2"; // the two dups the policy knows: 2>&1 and >&2
        const after = cmd[i + 3];
        if (cmd[i + 2] !== want || (after !== undefined && !/[\s;|&]/.test(after))) return shell(">&");
        i += 2; toks.push({ k: "dup" }); continue;
      }
      if (cmd[i + 1] === ">") { i++; toks.push({ k: "redir", v: fd2 ? "2>>" : ">>" }); } else toks.push({ k: "redir", v: fd2 ? "2>" : ">" });
      continue;
    }
    if (ch === "*" || ch === "?" || ch === "[") glob = true;
    cur += ch;
  }
  if (quote) return shell(quote); // an unclosed quote
  flush();
  return toks;
}

type Cmd = { words: string[]; globs: boolean[]; redirs: { op: string; target: string; g: boolean }[] };

/** tokens → commands split at `&& || ; |`, each with its words and its redirects (a redirect needs a target word) */
function commandsOf(toks: Tok[]): Cmd[] | Refusal {
  const cmds: Cmd[] = [];
  let cur: Cmd = { words: [], globs: [], redirs: [] };
  let lastOp = "";
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j]!;
    if (t.k === "word") { cur.words.push(t.v); cur.globs.push(t.g); }
    else if (t.k === "redir") {
      const next = toks[j + 1];
      if (next?.k !== "word") return shell(t.v); // a redirect with no target
      cur.redirs.push({ op: t.v, target: next.v, g: next.g });
      j++;
    } else if (t.k === "op") {
      if (cur.words.length === 0 && cur.redirs.length === 0) return shell(t.v); // `&& ls`, `ls ; ; ls`
      cmds.push(cur); cur = { words: [], globs: [], redirs: [] }; lastOp = t.v;
    }
  }
  if (cur.words.length === 0 && cur.redirs.length === 0) return cmds.length === 0 ? [] : shell(lastOp); // a trailing `&&` / `;` / `|`
  cmds.push(cur);
  return cmds;
}

// ---------- the program table (SPEC-108 D2) ----------

const READ = new Set(["pwd", "ls", "cat", "head", "tail", "grep", "wc", "diff", "sort", "uniq", "file", "stat", "du", "tree", "which", "echo", "printf", "true", "sleep", "date", "basename", "dirname", "realpath"]);
// no `sed`: its script can run a program (`1e cmd`) and write any file (`w path`); a worker edits files with Edit / Write, and the workspace hook already blocks `sed -i` (Silver's F2, TASK-118 rework)
const WRITE = new Set(["mkdir", "touch", "cp", "mv", "rm", "chmod", "tee"]);
const NETWORK_NEVER = new Set(["nc", "ncat", "ssh", "scp", "sftp", "rsync", "telnet", "ftp"]);
const GIT_READ = new Set(["status", "log", "diff", "show", "ls-files", "blame", "rev-parse"]);
/** `find` actions that run or write: the first four are the SPEC's; -delete and the -f* printers are the same kind (fail closed) */
const FIND_REFUSED = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const INLINE = new Set(["-e", "--eval", "-p", "--print"]);
/** curl / wget options that take the NEXT word as their value, so it is not a URL. PER PROGRAM: the two disagree (`-c`, `-r`, `-H`, `-b`, `-d`, `-m` are flags in wget and take a value
 *  in curl), and treating a flag as "takes a value" would swallow the URL and skip the host check. An option missing here is read as a flag: its value then counts as a URL and is refused. */
const VALUE_OPTS: Record<"curl" | "wget", Set<string>> = {
  curl: new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-H", "--header", "-X", "--request", "-u", "--user", "-A", "--user-agent", "-e", "--referer",
    "-b", "--cookie", "-c", "--cookie-jar", "-F", "--form", "-T", "--upload-file", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "--retry", "-o", "--output", "-r", "--range"]),
  wget: new Set(["-O", "--output-document", "-o", "--output-file", "-a", "--append-output", "-P", "--directory-prefix", "-T", "--timeout", "-t", "--tries", "-w", "--wait",
    "--header", "--post-data", "--post-file", "--user", "--password", "-A", "--accept", "-R", "--reject", "-X", "--exclude-directories", "-I", "--include-directories", "-l", "--level", "-Q", "--quota"]),
};
/** the value options that name a file the program WRITES — judged as a write path */
const OUTPUT_OPTS: Record<"curl" | "wget", Set<string>> = {
  curl: new Set(["-o", "--output", "-c", "--cookie-jar"]),
  wget: new Set(["-O", "--output-document", "-o", "--output-file", "-a", "--append-output", "-P", "--directory-prefix"]),
};
/** options that can send a request somewhere we cannot judge (a config file, a proxy, a list of URLs, wget's `-e` wgetrc commands) */
const NET_UNJUDGEABLE: Record<"curl" | "wget", (a: string) => boolean> = {
  curl: (a) => a === "-K" || a === "--config" || a.startsWith("--config=") || a === "-x" || a === "--proxy" || a.startsWith("--proxy="),
  wget: (a) => a === "-i" || a === "--input-file" || a.startsWith("--input-file=") || a === "-e" || a === "--execute" || a.startsWith("--execute=") || a === "-Y" || a === "--proxy" || a.startsWith("--proxy="),
};
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** the host of a URL-ish word: without scheme, credentials, port, path */
function hostOf(target: string): string {
  let rest = target.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
  rest = rest.split(/[/?#]/)[0]!;
  rest = rest.slice(rest.lastIndexOf("@") + 1);
  if (rest.startsWith("[")) { const end = rest.indexOf("]"); return end < 0 ? rest : rest.slice(0, end + 1); }
  return rest.replace(/:\d*$/, "");
}

type Ctx = { cwd: string; readable: string[]; readOnly: string[] };

/** one path against the folders: `outside` unless it lands in a readable folder; with `write`, `read_only` if it lands in a read-only one. `force` = it IS a path (a redirect target,
 *  a `-C` dir) even if it does not exist yet; otherwise only a word that looks like one is judged (starts with `/` or `~`, contains `..`, or exists relative to the cwd). */
function pathProblem(word: string, ctx: Ctx, write: boolean, force = false): Refusal | null {
  const cands = force ? [word] : candidates(word);
  // `~name`, `~+`, `~-` expand to another user's home / the working dirs: absolute() only knows `~` and `~/…`, so such a word would be judged as a plain relative name (F1).
  // Looked for in EVERY candidate first (`-f~box/x` also yields `/x`, which must not be judged before `~box/x` is seen).
  for (const c of cands) if (c.startsWith("~") && c !== "~" && !c.startsWith("~/")) return shell(c.split("/")[0]!);
  for (const c of cands) {
    if (c === "") continue;
    // a word that is going to be WRITTEN and has a directory part (`src/new.ts`) is a path even when nothing is there yet — else a new file in a read-only folder would slip through
    if (!force && !(c.startsWith("/") || c.startsWith("~") || c.includes("..") || existsSync(resolve(ctx.cwd, c)) || (write && c.includes("/")))) continue;
    const real = realOf(absolute(c, ctx.cwd));
    if (!ctx.readable.some((d) => inside(real, d))) return { code: "outside", detail: real };
    if (write && ctx.readOnly.some((d) => inside(real, d))) return { code: "read_only", detail: real };
  }
  return null;
}

const firstProblem = (words: string[], ctx: Ctx, write: boolean): Refusal | null => {
  for (const w of words) { const p = pathProblem(w, ctx, write); if (p) return p; }
  return null;
};

/** the cwd is where bun / node / a writer works: it must not be a read-only folder */
const cwdWritable = (ctx: Ctx): Refusal | null => {
  const real = realOf(ctx.cwd);
  return ctx.readOnly.some((d) => inside(real, d)) ? { code: "read_only", detail: real } : null;
};

function judgeGit(args: string[], ctx: Ctx): Refusal | null {
  let sub: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--output" || a.startsWith("--output=")) return { code: "git_write", detail: "--output" };
    if (sub !== null) continue;
    if (a === "-C") { const dir = args[++i]; if (dir === undefined) return { code: "git_write", detail: "-C" }; const p = pathProblem(dir, ctx, false, true); if (p) return p; continue; }
    if (a === "-c") return { code: "git_write", detail: "-c" }; // a config override can run a program (core.pager, alias)
    if (a.startsWith("-")) continue;
    sub = a;
  }
  if (sub !== null && !GIT_READ.has(sub)) return { code: "git_write", detail: sub };
  if (sub === null) return null; // `git` alone, `git --version`
  return firstProblem(args, ctx, false);
}

/** `-d @file` / `-F name=@file`: curl reads that file — it is a path to judge as a read */
const atFile = (v: string): string | null => { const at = v.startsWith("@") ? 0 : v.indexOf("=@") >= 0 ? v.indexOf("=@") + 1 : -1; return at < 0 ? null : v.slice(at + 1); };

function judgeNetwork(prog: "curl" | "wget", args: string[], ctx: Ctx): Refusal | null {
  const targets: string[] = [];
  let optionsDone = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (optionsDone || !a.startsWith("-")) { targets.push(a); continue; }
    if (a === "--") { optionsDone = true; continue; }
    if (NET_UNJUDGEABLE[prog](a)) return { code: "network", detail: a };
    if (a === "--url") { const u = args[++i]; if (u !== undefined) targets.push(u); continue; }
    if (VALUE_OPTS[prog].has(a)) {
      const v = args[++i];
      if (v === undefined) continue;
      const file = atFile(v);
      const p = (OUTPUT_OPTS[prog].has(a) ? pathProblem(v, ctx, true, true) : null) ?? (file !== null ? pathProblem(file, ctx, false, true) : null);
      if (p) return p;
    }
  }
  for (const t of targets) if (!LOCAL_HOSTS.has(hostOf(t))) return { code: "network", detail: t };
  return null;
}

/** F3: an unquoted word with a path segment that starts with `.` and holds a glob character (`.?`, `.*`, `.[.]`) can expand to `..` on a shell without `globskipdots`, and climb out of the folder
 *  where the policy cannot see it. Refused whole — so `ls .*` is refused too, which is acceptable: say `ls -A`. A QUOTED word (a regex such as `'.*'`) is not expanded and is not touched. */
function dotGlob(word: string, glob: boolean): Refusal | null {
  if (!glob) return null;
  const seg = word.split("/").find((s) => s.startsWith(".") && s !== "." && s !== ".." && /[*?[]/.test(s));
  return seg === undefined ? null : shell(seg);
}

function judgeCommand(cmd: Cmd, ctx: Ctx): Refusal | null {
  for (let i = 0; i < cmd.words.length; i++) { const d = dotGlob(cmd.words[i]!, cmd.globs[i]!); if (d) return d; }
  for (const r of cmd.redirs) { const d = dotGlob(r.target, r.g); if (d) return d; }
  const [prog, ...args] = cmd.words;
  if (prog === undefined) return { code: "not_allowed", detail: "" };
  if (prog.includes("/")) return { code: "not_allowed", detail: prog }; // a program is a bare name, never a path
  let own: Refusal | null;
  if (READ.has(prog)) own = firstProblem(args, ctx, false);
  else if (WRITE.has(prog)) own = cwdWritable(ctx) ?? firstProblem(args, ctx, true);
  else if (prog === "find") {
    const bad = args.find((a) => FIND_REFUSED.has(a));
    own = bad ? { code: "not_allowed", detail: `find ${bad}` } : firstProblem(args, ctx, false);
  } else if (prog === "git") own = judgeGit(args, ctx);
  else if (prog === "bun" || prog === "bunx" || prog === "node") {
    const inline = args.find((a) => INLINE.has(a) || a.startsWith("--eval=") || a.startsWith("--print="));
    if (inline) own = { code: "inline_code", detail: inline };
    else if (prog === "bun" && args[0] === "publish") own = { code: "not_allowed", detail: "bun publish" };
    else own = cwdWritable(ctx) ?? firstProblem(args, ctx, true);
  } else if (prog === "curl" || prog === "wget") own = judgeNetwork(prog, args, ctx) ?? firstProblem(args.filter((a) => !a.startsWith("-") && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(a)), ctx, false);
  else if (NETWORK_NEVER.has(prog)) own = { code: "network", detail: prog };
  else own = { code: "not_allowed", detail: prog };
  if (own) return own;
  for (const r of cmd.redirs) {
    if (r.target === "/dev/null") continue; // discarding output is harmless
    const p = pathProblem(r.target, ctx, r.op !== "<", true); // a redirect target IS a path; `>` types are writes
    if (p) return p;
  }
  return null;
}

/** null = the command may run; otherwise the first refusal. `readable` = the project's folders (+ the hop's own), `readOnly` ⊆ them. */
export function judgeBash(command: string, cwd: string, readable: string[], readOnly: string[]): null | Refusal {
  const toks = tokenize(command);
  if (!Array.isArray(toks)) return toks;
  const cmds = commandsOf(toks);
  if (!Array.isArray(cmds)) return cmds;
  if (cmds.length === 0) return { code: "not_allowed", detail: "" };
  const ctx: Ctx = { cwd, readable: readable.map((d) => realOf(d)), readOnly: readOnly.map((d) => realOf(d)) };
  for (const c of cmds) { const r = judgeCommand(c, ctx); if (r) return r; }
  return null;
}
