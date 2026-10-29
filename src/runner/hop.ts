// Run ONE hop: one turn of one worker on one card, as a headless `claude -p` child (SPEC-C-003 § 2–3).
// The hop row already exists (started by the screen or by the runner's restart rule); this finishes it, whatever happens.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Api, type ApiEvent, type Card, type Finish, type Hop, type HopOutcome, type Project, type Worker, RunnerApiError, readOnlyOf } from "./api";
import type { RunnerConfig } from "./config";
import { type Thread, buildChatPrompt, buildPrompt, folderNames, loadSkills, threadOf, writeSkillsFile } from "./prompt";
import { type Procs, defaultHopsDir, realProcs, removeHopFile, writeHopFile } from "./procs";
import type { Code } from "./bash-policy";
import { redact } from "./redact";
import { createScreenSender, liveRedact, screenLines } from "./screen";
import { withReadGuard, withReadOnly } from "./settings";
import { type Limit, StreamState } from "./stream";
import { formatReset } from "./thai";
import { toolSummary, writeTrace } from "./trace";

/** REQ-012 wording table (decided 2026-10-14). A hop is a "ก้าว", a run a "รอบ". */
export const NOTES = {
  noRoots: "ยังไม่ได้กำหนดโฟลเดอร์ — ทีมจะยังเริ่มทำงานไม่ได้",
  skillMissing: (name: string) => `ไม่พบสกิล ${name}`,
  timeout: "หมดเวลา — ก้าวนี้ใช้เวลานานเกินไป",
  noResult: "ก้าวนี้ไม่ได้ทิ้งผลงานไว้",
  /** REQ-111 wording (PM, 2026-10-29): one sentence per refusal, the reason from REFUSAL_REASON below; at most 3 distinct, then `refusedMore` */
  refused: (reason: string) => `คำสั่งนี้ทำไม่ได้: ${reason} — ทำต่อด้วยวิธีอื่น`,
  refusedMore: (n: number) => `(อีก ${n} ครั้ง)`,
  /** the 10th refusal in one hop stops it (SPEC-108 D4, REQ-111 Q2) */
  refusalCap: "หยุดไว้: คำสั่งถูกปฏิเสธครบ 10 ครั้งในก้าวเดียว",
  interrupted: "ถูกขัดจังหวะเพราะตัวรันเริ่มใหม่",
  fault: (message: string) => `ตัวรันขัดข้อง: ${message}`,
  /** `[PM-decided]` (SPEC-103 Q4, Porter 2026-10-29): a project folder is not under CAW_WORKSPACE_ROOT — the hop is refused before claude starts */
  outsideWorkspace: "โฟลเดอร์งานต้องอยู่ใน CAW_WORKSPACE_ROOT — ก้าวนี้ไม่ได้เริ่ม",
  /** REQ-012: ถึงลิมิตการใช้งาน Claude — จะทำต่อได้หลัง {เวลา}; without a reset time only the part that needs none */
  limit: (resetsAt: number | null, now: Date) => `ถึงลิมิตการใช้งาน Claude${resetsAt === null ? "" : ` — จะทำต่อได้หลัง ${formatReset(resetsAt, now)}`}`,
} as const;

/** `pid` is the child's process id; with the real spawner it is also its process group id (the child leads its own group). */
export type Child = { pid?: number; stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(signal?: string): void; stderrText(): Promise<string> };
export type Spawner = (cmd: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => Child;

export type HopDeps = {
  api: Api; config: RunnerConfig; spawn: Spawner;
  /** the generated worker settings (settings.ts), written once per runner start */
  settingsFile: string;
  /** a per-runner temp folder (outside any repo); one sub-folder per hop, removed when the hop ends */
  tmpRoot: string;
  log: (line: string) => void;
  /** true once the runner has been told to stop: a child that dies with it is NOT the hop's result, so the hop is left running
   *  in the store and the next runner marks it `interrupted` (SPEC-C-003 § 1.1, AC-4) */
  stopping?: () => boolean;
  /** this runner's instance id, written into each hop file */
  instance?: string;
  /** where the per-hop files go (default `<os.tmpdir()>/caw-runner/hops`) and how processes are looked at / signalled (default: the real ones) */
  hopsDir?: string;
  procs?: Procs;
  /** the clock, for the reset time in the limit note (default: the real one) */
  now?: () => Date;
  /** how long a child gets after SIGTERM before it is sent SIGKILL (default 5000 ms) */
  killGraceMs?: number;
  /** where each hop's stream is kept as `<hopId>.jsonl` (trace.ts); unset = no trace (tests) */
  traceDir?: string;
  /** values the screen must never show (screen.ts `secretValues`), built once at runner start; unset = none beyond the key shapes */
  secrets?: readonly string[];
  /** per project: the last event seq seen, so "where am I now" is not a walk from 0 every hop */
  cursors: Map<string, number>;
};
/** `card` is set for a card hop and absent for a chat hop (which has `hop.messageId` instead). */
export type HopInput = { project: Project; hop: Hop; worker: Worker; card?: Card };

/** Real child: Bun.spawn on its own handle — never pkill. `detached: true` (setsid) puts it in its OWN process group, so claude, its MCP server and its
 *  Bash children can be stopped together, and so a runner that dies hard leaves a group its successor can find (procs.ts). */
export const bunSpawn: Spawner = (cmd, { cwd, env }) => {
  const p = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  return {
    pid: p.pid, stdout: p.stdout, exited: p.exited, stderrText: () => new Response(p.stderr).text(),
    kill: (signal) => {
      const sig = (signal ?? "SIGTERM") as NodeJS.Signals;
      try { process.kill(-p.pid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return; p.kill(sig); } // the whole group, not just the pid
    },
  };
};

/** how often a hop's stream may tell the core it is alive (contract v1.11; the core itself writes at most once a minute) */
const HEARTBEAT_MS = 30_000;

/** SPEC-108 D4: no refusal ends a hop — claude has already handed the refusal to the model, which can try another way. The 10th one in a hop stops it (a worker that tries ten
 *  commands in a row is probing, not working). */
const REFUSAL_CAP = 10;

/** What was refused: one of our hook's codes, `guard` (a workspace guard hook), or `tool` (claude itself refused a tool in this step). `detail` is the path, program, character or tool named. */
type RefusalKind = Code | "guard" | "tool";
type Refusal = { kind: RefusalKind; detail: string };
const CODES = "shell_feature|not_allowed|git_write|inline_code|network|outside|read_only";

/** One stream block → what was refused. Our hook's stderr is `caw-refused <code>: <English with the detail in the FIRST double quotes>` (read-guard.ts; the file tools' `outside` line has the
 *  path unquoted: `read guard: <path> is outside …`). A hook block without that prefix is a workspace guard hook; a `permission` block is claude refusing a tool. */
export function refusalOf(b: { kind: string; tool: string; text: string }): Refusal {
  if (b.kind === "permission") return { kind: "tool", detail: b.tool };
  const hit = new RegExp(`caw-refused (${CODES}): ([\\s\\S]*)`).exec(b.text);
  if (!hit) return { kind: "guard", detail: "" };
  const rest = hit[2]!;
  return { kind: hit[1] as Code, detail: /"([^"]*)"/.exec(rest)?.[1] ?? /read guard: (.+?) is outside/.exec(rest)?.[1] ?? "" };
}

/** The Thai {เหตุผล} per refusal, one table — REQ-111 Q2, all ten accepted as written by the PM (2026-10-29) */
export const REFUSAL_REASON: Record<RefusalKind, (detail: string) => string> = {
  outside: (d) => `${d} อยู่นอกโฟลเดอร์งาน`,
  read_only: (d) => `โฟลเดอร์ ${d} อ่านได้อย่างเดียว`,
  not_allowed: (d) => `${d} ไม่ใช่คำสั่งที่ worker ใช้ได้`,
  shell_feature: (d) => `ใช้ ${d} ในคำสั่งไม่ได้`,
  git_write: () => "worker เขียน git ไม่ได้",
  network: () => "ออกเน็ตได้แค่ 127.0.0.1 กับที่ลงแพ็กเกจ",
  inline_code: () => "รันโค้ดจากบรรทัดคำสั่งไม่ได้ — เขียนเป็นไฟล์ก่อน",
  guard: () => "กฎความปลอดภัยกันไว้",
  tool: (d) => `เครื่องมือ ${d} ใช้ในก้าวนี้ไม่ได้`,
};

/** The hop note's refusal part: each DISTINCT (kind, detail) as the PM's sentence, at most 3, then `(อีก n ครั้ง)` for the refusals those three do not cover; redacted like the rest of the note. */
export function refusedNote(list: readonly Refusal[]): string {
  if (list.length === 0) return "";
  const key = (r: Refusal) => `${r.kind}\u0000${r.detail}`;
  const distinct = new Map<string, Refusal>();
  for (const r of list) if (!distinct.has(key(r))) distinct.set(key(r), r);
  const shown = [...distinct.values()].slice(0, 3);
  const shownKeys = new Set(shown.map(key));
  const more = list.filter((r) => !shownKeys.has(key(r))).length;
  const parts = shown.map((r) => NOTES.refused(REFUSAL_REASON[r.kind](r.detail)));
  if (more > 0) parts.push(NOTES.refusedMore(more));
  return redact(parts.join(" · "));
}

/** Folder confinement (TASK-112, owner 13:41: no Bash sandbox, "จัดวาง folder"): every project folder, by REAL path, must be inside CAW_WORKSPACE_ROOT — and not that folder
 *  itself, nor inside its `scripts/` (the guard hooks) or `.claude/` (the skills). Returns the first folder that is not, or null. A folder that does not exist yet is judged as given. */
export function folderOutsideWorkspace(folders: readonly string[], workspaceRoot: string): string | null {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  const ws = real(workspaceRoot);
  const barred = ["scripts", ".claude"].flatMap((d) => [join(ws, d), real(join(ws, d))]);
  for (const f of folders) {
    const r = real(f);
    if (r === ws || !within(r, ws) || barred.some((b) => within(r, b))) return f;
  }
  return null;
}

/** The folders a hop may read: the project's roots and its own private folder — each as given and, when it differs, by its real path (macOS: /var → /private/var). */
export function readableDirs(roots: readonly string[], hopDir: string): string[] {
  const out: string[] = [];
  for (const d of [...roots, hopDir]) {
    out.push(d);
    try { out.push(realpathSync(d)); } catch { /* not there (yet): the path as given is all there is */ }
  }
  return [...new Set(out)];
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the child may see of the runner's environment: the login/shell basics only. Everything else — API keys, cloud credentials,
 *  DATABASE_URL, SSH agent — stays out of a process that runs model-directed commands (security review F4). */
const CHILD_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL"] as const;
export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}

/** After the leader is gone: is anything of its group still running (claude's MCP server, a Bash child that shrugged off SIGTERM)? Give it the grace
 *  period, then SIGKILL the group. True once the group is empty. */
async function settleGroup(pgid: number, procs: Procs, graceMs: number, log: (line: string) => void): Promise<boolean> {
  for (let waited = 0; waited < graceMs && procs.groupAlive(pgid); waited += 100) await procs.sleep(Math.min(100, graceMs));
  if (procs.groupAlive(pgid)) {
    log(`group ${pgid}: still has processes ${graceMs} ms after its leader ended — SIGKILL`);
    try { procs.killGroup(pgid, "SIGKILL"); } catch (e) { log(`group ${pgid}: could not send SIGKILL: ${messageOf(e)}`); }
    for (let waited = 0; waited < 2000 && procs.groupAlive(pgid); waited += 100) await procs.sleep(100);
  }
  return !procs.groupAlive(pgid);
}

/** SIGTERM now, SIGKILL after the grace period if it is still there — a child must not be able to keep a hop (and the repo) forever. */
function terminate(child: Child, graceMs: number): void {
  child.kill();
  const t = setTimeout(() => child.kill("SIGKILL"), graceMs);
  void child.exited.finally(() => clearTimeout(t));
}

const SERVER = fileURLToPath(new URL("../mcp/server.ts", import.meta.url));

/** Only CAW's server (SPEC-A-008): with --strict-mcp-config no other MCP server — Slack, mail … — is reachable (R5). The server's
 *  cwd is the worker's folder, so its script is given by absolute path. */
export function buildMcpConfig(apiUrl: string, workerId: string, hopId: string): object {
  // CAW_HOP_ID (contract v1.5): the MCP server names this hop on every worker write, so a write of a hop that is no longer running is refused
  return { mcpServers: { caw: { type: "stdio", command: process.execPath, args: ["run", SERVER], env: { CAW_API_URL: apiUrl, CAW_WORKER_ID: workerId, CAW_HOP_ID: hopId } } } };
}

/** `--add-dir` and `--disallowedTools` take a LIST, so each is followed by another flag — never by the next positional. */
/** A chat hop is a conversation, not coding (TASK-C-036 (c)); since TASK-C-041 it may also READ the project's folders for the setup step:
 *  `--tools Read,Glob,Grep` and no shell, so nothing can be written. The writing and running tools are denied by name as well. With no folders
 *  there is nothing to read: `--tools ""`, and Read / Glob / Grep are denied too. */
const CHAT_READ_TOOLS = ["Read", "Glob", "Grep"];
const CHAT_DENY = ["Bash", "Write", "Edit", "NotebookEdit", "Task", "WebFetch", "WebSearch"];

export function buildArgs(a: { prompt: string; worker: Pick<Worker, "model" | "effort">; roots: string[]; settingsFile: string; mcpFile: string; skillsFile: string | null; chat?: boolean }): string[] {
  return [
    "-p", a.prompt,
    "--model", a.worker.model, "--effort", a.worker.effort,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    // the operator's own ~/.claude (hooks, plugins, CLAUDE.md) is not loaded (R-5); the generated settings below are added to the project's
    "--setting-sources", "project",
    "--settings", a.settingsFile,
    "--mcp-config", a.mcpFile, "--strict-mcp-config",
    // a card hop runs IN the first root, so only the rest are added; a chat hop runs in its private folder, so every root is added
    ...(a.chat ? (a.roots.length > 0 ? ["--add-dir", ...a.roots] : []) : a.roots.length > 1 ? ["--add-dir", ...a.roots.slice(1)] : []),
    ...(a.chat ? ["--tools", a.roots.length > 0 ? CHAT_READ_TOOLS.join(",") : ""] : []),
    "--disallowedTools", ...(a.chat ? (a.roots.length > 0 ? CHAT_DENY : [...CHAT_DENY, ...CHAT_READ_TOOLS]) : ["WebFetch", "WebSearch"]),
    ...(a.skillsFile ? ["--append-system-prompt-file", a.skillsFile] : []),
    "--no-session-persistence",
  ];
}

const OUTCOME: Record<string, HopOutcome> = {
  "card.commented": "commented", "card.handed_off": "handed_off", "card.status_set": "status", "card.question_opened": "asked",
};
const cardOf = (e: ApiEvent): string | undefined => (e.type === "card.question_opened" ? e.data?.askingCardId : e.data?.cardId);

export async function eventsAfter(api: Api, projectId: string, after: number): Promise<ApiEvent[]> {
  const all: ApiEvent[] = [];
  for (;;) {
    const page = await api.events(projectId, after, 500);
    if (page.length === 0) return all; // until an EMPTY page: the API may give fewer than asked for
    all.push(...page);
    after = page[page.length - 1]!.seq;
  }
}

async function latestSeq(deps: HopDeps, projectId: string): Promise<number> {
  const seen = deps.cursors.get(projectId) ?? 0;
  const tail = await eventsAfter(deps.api, projectId, seen);
  const seq = tail.length ? tail[tail.length - 1]!.seq : seen;
  deps.cursors.set(projectId, seq);
  return seq;
}

/** Read newline-delimited text from a byte stream; `onLine` returns false to stop reading. A last line without "\n" still counts. */
async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => boolean, log: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line !== "" && !onLine(line)) return;
      }
    }
    buf += dec.decode();
    if (buf !== "") onLine(buf);
  } finally {
    await reader.cancel().catch((e) => log(`could not close claude's output stream: ${messageOf(e)}`));
  }
}

/** The chat up to and including `messageId`, read page by page (oldest first) — a few pages at most; a failure to read it is not the hop's failure:
 *  the worker then gets the plain prompt and `chat_context` still shows it the thread. */
async function threadFor(deps: HopDeps, projectId: string, messageId: string): Promise<Thread | null> {
  try {
    const all: Awaited<ReturnType<Api["chatMessages"]>> = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const got = await deps.api.chatMessages(projectId, after);
      if (got.length === 0) break;
      all.push(...got);
      if (got.some((m) => m.id === messageId)) return threadOf(all, messageId);
      after = got[got.length - 1]!.id;
    }
    return null;
  } catch (e) {
    deps.log(`hop: could not read the chat for the thread (${messageOf(e)}) — plain prompt`);
    return null;
  }
}

/** `limit`: the subscription-limit signal the hop saw, if any — acting on it (ending the run) is the caller's. */
export type HopResult = { hop: Hop; limit: Limit | null };

export async function runHop(deps: HopDeps, input: HopInput): Promise<HopResult> {
  const box = { limit: null as Limit | null };
  const hop = await runOne(deps, input, box);
  return { hop, limit: box.limit };
}

async function runOne(deps: HopDeps, input: HopInput, box: { limit: Limit | null }): Promise<Hop> {
  const { api, config } = deps;
  const log = (line: string) => deps.log(redact(line)); // nothing secret reaches the log or the stored note (F8)
  const { project, hop, worker, card } = input;
  const messageId = hop.messageId; // set = a CHAT hop: the entry worker answering an operator message (TASK-C-034)
  const workerActor = `worker:${worker.id}`; // who the MCP tools write as — the hop's own writes are the runner's (api.ts)
  const finish = (f: Finish) => api.finishHop(hop.id, f);
  const dir = join(deps.tmpRoot, `hop-${hop.id}`);
  let spawnedPid: number | undefined;
  try {
    // Readable = roots; writable = roots − readOnly (D-100). A card hop works in the first WRITABLE root and reads the rest; a chat hop reads them all.
    const readOnly = readOnlyOf(project.workspace);
    const writable = project.workspace.roots.filter((r) => !readOnly.includes(r));
    const roots = [...writable, ...project.workspace.roots.filter((r) => readOnly.includes(r))];
    // A chat hop needs no folder to talk (MCP), but it READS the project's folders for the setup step (C-041): they are added, never its cwd (see below).
    if (messageId === null && writable.length === 0) { log(`hop ${hop.id}: the project has no workspace folders — hop stopped`); return await finish({ outcome: "stopped", note: NOTES.noRoots }); }
    // Without the Bash sandbox, the folders ARE the fence: no claude starts on a folder outside CAW_WORKSPACE_ROOT (TASK-112). Chat hops read the roots, so it counts for them too.
    const stray = folderOutsideWorkspace(project.workspace.roots, config.workspaceRoot);
    if (stray !== null) { log(`hop ${hop.id}: the project folder ${stray} is not inside CAW_WORKSPACE_ROOT ${config.workspaceRoot} (or is its scripts/ or .claude/) — hop stopped, claude not started`); return await finish({ outcome: "stopped", note: NOTES.outsideWorkspace }); }
    const skills = loadSkills(config.workspaceRoot, worker.skills);
    if (!skills.ok) { log(`hop ${hop.id}: skill ${skills.missing} not found under ${config.workspaceRoot}/.claude/skills — hop stopped`); return await finish({ outcome: "stopped", note: NOTES.skillMissing(skills.missing) }); }

    const startSeq = await latestSeq(deps, project.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const mcpFile = join(dir, "mcp.json");
    writeFileSync(mcpFile, JSON.stringify(buildMcpConfig(config.apiUrl, worker.id, hop.id)), { mode: 0o600 });
    const skillsFile = skills.text === "" ? null : writeSkillsFile(dir, skills.text);
    const prompt = messageId !== null ? buildChatPrompt({ worker, messageId, projectId: project.id, thread: await threadFor(deps, project.id, messageId), folders: folderNames(project.workspace.roots) }) : buildPrompt({ worker, card: card!, projectId: project.id });
    // EVERY hop gets its own settings file = the runner's base + the read fence (UP-3: reads only inside the roots and this hop's folder) + the read-only
    // denies of a card hop (a chat hop writes nothing anyway). The base is read here, so a hop never runs on settings it could not read: it fails instead.
    const settingsFile = join(dir, "settings.json");
    const base = JSON.parse(readFileSync(deps.settingsFile, "utf8"));
    writeFileSync(settingsFile, `${JSON.stringify(withReadGuard(messageId === null ? withReadOnly(base, readOnly) : base, readableDirs(project.workspace.roots, dir), messageId === null ? readOnly : []), null, 2)}\n`, { mode: 0o600 });
    const args = buildArgs({ prompt, worker, roots: messageId !== null ? project.workspace.roots : roots, settingsFile, mcpFile, skillsFile, chat: messageId !== null });

    // A child must never be started by a runner that is already stopping: nothing would be left to kill it.
    if (deps.stopping?.()) { log(`hop ${hop.id}: runner is stopping — not started, left running for the next runner to interrupt`); return hop; }
    // a chat hop runs in its own private hop folder, never in the project's repo
    const child = deps.spawn([config.claudeBin, ...args], { cwd: messageId !== null ? dir : roots[0]!, env: childEnv(process.env) });
    spawnedPid = child.pid;
    const stderr = child.stderrText().catch((e) => { log(`hop ${hop.id}: could not read claude's stderr: ${messageOf(e)}`); return ""; }); // drained from the start, so a full pipe can never stall the child
    const state = new StreamState();
    const end = { note: null as string | null };
    const refusals: Refusal[] = []; // every block in this hop, in order (SPEC-108 D4): none ends the hop except the REFUSAL_CAP-th
    // Heartbeat (contract v1.11, D-066): while claude's stream prints, tell the core the hop is alive — at most one every 30 s, never awaited, never a timer
    // (a hung child prints nothing, so it must not look alive). `lastSent` starts at the spawn: `hop.started` already stamped the first activity.
    const clock = () => (deps.now ?? (() => new Date()))().getTime();
    const beat = { lastSent: clock(), inFlight: false, over: false };
    const lines: string[] = []; // the stream as claude printed it, for the trace
    const stop = () => terminate(child, deps.killGraceMs ?? 5000);
    const timer = setTimeout(() => { end.note ??= NOTES.timeout; stop(); }, config.hopMaxMs);
    // REQ-104: what the CLI prints is also shown, rendered and redacted, on the worker's screen. It rides on the stream read below and can change nothing of the hop:
    // the sender never throws and never makes the hop wait for the API (screen.ts).
    const secrets = deps.secrets ?? [];
    const screen = createScreenSender({ post: (id, entries) => api.hopOutput(id, entries), hopId: hop.id, now: deps.now ?? (() => new Date()), log });
    let code: number;
    try {
      // The record that lets the NEXT runner find this child if this one is killed hard (procs.ts). Written the moment the child exists.
      if (child.pid !== undefined) {
        const procs = deps.procs ?? realProcs;
        const lstart = procs.inspect(child.pid)?.lstart;
        if (lstart === undefined) log(`hop ${hop.id}: could not inspect the child (pid ${child.pid}) — no hop file`);
        else writeHopFile(deps.hopsDir ?? defaultHopsDir(), {
          hopId: hop.id, projectId: project.id, apiUrl: config.apiUrl, pid: child.pid, pgid: child.pid, instance: deps.instance ?? "?", claudeBin: config.claudeBin,
          startedAt: new Date().toISOString(), lstart, runnerPid: process.pid, runnerLstart: procs.inspect(process.pid)?.lstart ?? "",
        });
      }
      await readLines(child.stdout, (line) => {
        lines.push(line);
        try { for (const t of screenLines(line)) screen.push(liveRedact(t, secrets)); } catch (e) { log(`hop ${hop.id}: screen line skipped: ${messageOf(e)}`); }
        if (end.note === null && !beat.over && !beat.inFlight && !deps.stopping?.() && clock() - beat.lastSent >= HEARTBEAT_MS) {
          beat.lastSent = clock();
          beat.inFlight = true;
          // a failed heartbeat never stops or fails the hop; once the core says the hop is not running, there is nothing more to tell it
          void deps.api.heartbeat(hop.id)
            .catch((e) => { if (e instanceof RunnerApiError && e.code === "hop_not_running") beat.over = true; log(`hop ${hop.id}: heartbeat failed: ${e instanceof RunnerApiError ? e.code : messageOf(e)}`); })
            .finally(() => { beat.inFlight = false; });
        }
        const blocks = state.feed(line);
        for (const b of end.note === null ? blocks : []) {
          // a refusal (our hook, a workspace guard hook, or claude's own permission deny): claude has already told the model, so the hop goes on — recorded for the note
          const r = refusalOf(b);
          refusals.push(r);
          log(`hop ${hop.id}: refused ${refusals.length} of ${REFUSAL_CAP} — ${r.kind}${r.detail === "" ? "" : ` ${r.detail}`}: ${b.action}`);
          if (refusals.length >= REFUSAL_CAP) {
            end.note = NOTES.refusalCap;
            log(`hop ${hop.id}: ${REFUSAL_CAP} refusals in one hop — hop stopped`);
            stop();
            return false;
          }
        }
        if (state.limit && end.note === null) {
          // the subscription limit (REQ-012 R6): no point waiting for a child that cannot go on
          box.limit = state.limit;
          end.note = NOTES.limit(state.limit.resetsAt, (deps.now ?? (() => new Date()))());
          log(`hop ${hop.id}: limit signal ${JSON.stringify(state.limit)}`);
          stop();
          return false;
        }
        return end.note === null;
      }, log);
      code = await child.exited;
    } catch (e) {
      stop(); // could not read its output: end it rather than leave a worker running unwatched in the repo
      throw e;
    } finally {
      clearTimeout(timer);
      await screen.close(); // what is queued goes out (≤ 3 s); never throws
      // kept whatever happened — a hop that is stopped or killed is the one somebody will want to read
      if (deps.traceDir) {
        try { log(`hop ${hop.id}: trace ${writeTrace(deps.traceDir, hop.id, lines)}`); } catch (e) { log(`hop ${hop.id}: could not write the trace: ${messageOf(e)}`); }
      }
    }

    const sum = state.summary();
    if (code !== 0 || sum.isError) log(`hop ${hop.id}: claude exit ${code}, is_error ${sum.isError}, stderr: ${(await stderr).slice(0, 300)}`);
    log(`hop ${hop.id}: init: ${JSON.stringify(sum.init)}; usage: in ${sum.usage?.input ?? "-"}, cacheCreation ${sum.usage?.cacheCreation ?? "-"}, cacheRead ${sum.usage?.cacheRead ?? "-"}, out ${sum.usage?.output ?? "-"}`);
    if (state.unparsed > 0) log(`hop ${hop.id}: ${state.unparsed} line(s) were not JSON`);
    if (state.faults > 0) log(`hop ${hop.id}: ${state.faults} line(s) could not be read (unexpected shape)`);
    if (deps.stopping?.()) { log(`hop ${hop.id}: runner is stopping — left running for the next runner to interrupt`); return hop; }
    // a hop that ended without a result says which tools it used, so a reader of the hop (not only of the trace) can see where it went
    const tools = toolSummary(lines, messageId !== null ? ["locate", "reply"] : []);
    const refused = refusedNote(refusals);
    const withTools = (note: string) => [note, refused, tools].filter((t) => t !== "").join(" · ").slice(0, 2000);
    const tokens = { ...(sum.tokensIn === null ? {} : { tokensIn: sum.tokensIn }), ...(sum.tokensOut === null ? {} : { tokensOut: sum.tokensOut }) };
    // the limit note is REQ-012's fixed Thai wording and its cause is known; every other stop says where the hop had got to
    if (end.note !== null) return await finish({ outcome: "stopped", note: box.limit ? end.note : withTools(end.note), ...tokens });

    const events = (await eventsAfter(api, project.id, startSeq)).filter((e) => e.actor === workerActor);
    // a child that exited non-zero says so in the note — a reader of the hop must not think it ended cleanly (Sector's review)
    const exit = code !== 0 ? `exit ${code}` : "";
    const okNote = [exit, refused].filter((t) => t !== "").join(" · "); // a hop that ends with a result still says what was refused on the way
    const failed = () => finish({ outcome: "failed", note: withTools(exit === "" ? NOTES.noResult : `${NOTES.noResult} · ${exit}`), ...tokens });

    if (messageId !== null) {
      // The reply decides (SPEC-C-004 § 2, C-Q7): no reply = the operator got no answer = failed. What it carried says the rest.
      const replied = events.find((e) => e.type === "chat.replied" && e.data?.messageId === messageId && e.data?.hopId === hop.id);
      if (!replied) return await failed();
      const proposed = events.some((e) => e.type === "proposal.made" && e.data?.messageId === messageId);
      const amended = replied.data?.amendment != null;
      const outcome: HopOutcome = proposed && amended ? "proposed_and_amended" : proposed ? "proposed" : amended ? "amended" : "replied";
      return await finish({ outcome, note: okNote, ...tokens });
    }
    const last = events.filter((e) => cardOf(e) === card!.id && OUTCOME[e.type] !== undefined).pop();
    return last ? await finish({ outcome: OUTCOME[last.type]!, note: okNote, ...tokens }) : await failed();
  } catch (e) {
    const msg = messageOf(e);
    log(`hop ${hop.id}: ${e instanceof Error ? (e.stack ?? msg) : msg}`);
    return await finish({ outcome: "failed", note: redact(NOTES.fault(msg)).slice(0, 300) });
  } finally {
    // the hop's result must not be replaced by a clean-up failure
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { log(`hop ${hop.id}: could not remove ${dir}: ${messageOf(e)}`); }
    // the hop is over: its file goes too — unless the runner is stopping, when the next runner needs it
    if (!deps.stopping?.()) {
      try {
        // the file is the next runner's only way to find what is left of this hop: it goes only when the whole group is gone
        const gone = spawnedPid === undefined || (await settleGroup(spawnedPid, deps.procs ?? realProcs, deps.killGraceMs ?? 5000, log));
        if (gone) removeHopFile(deps.hopsDir ?? defaultHopsDir(), hop.id);
        else log(`hop ${hop.id}: its process group ${spawnedPid} is still alive — the hop file is kept for the next runner`);
      } catch (e) { log(`hop ${hop.id}: could not remove its hop file: ${messageOf(e)}`); }
    }
  }
}
