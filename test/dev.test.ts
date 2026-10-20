// TASK-A-093 / SPEC-A-009 § R1a (REQ-015): `bun run dev` = src/dev.ts starts the API and the runner as two child processes with the same
// environment, prefixes every line `[api]` / `[runner]`, stops both on SIGINT / SIGTERM, stops the runner and exits with the API's code when
// the API exits, and — when the runner exits — prints `[runner] stopped: <its last line>` and KEEPS the API (no restart).
// The real entries are replaced through CAW_DEV_API_ENTRY / CAW_DEV_RUNNER_ENTRY by tiny stub scripts; dev.ts runs with `--no-env-file`
// and a minimal environment, so the operator's `.env` (SIT) is never loaded and no real API or runner starts.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()!(); } catch { /* already gone */ } } });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, probe: () => T | false | undefined | null, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = probe(); if (v) return v; await sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}

const API_STUB = `
const server = Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("api ok") });
console.log("api pid " + process.pid + " mark=" + process.env.CAW_MARK);
if (process.env.STUB_API_EXIT_AFTER_MS) setTimeout(() => { console.log("api bye"); process.exit(Number(process.env.STUB_API_EXIT_CODE || 0)); }, Number(process.env.STUB_API_EXIT_AFTER_MS));
`;
const RUNNER_STUB = `
console.log("runner pid " + process.pid + " mark=" + process.env.CAW_MARK);
if (process.env.STUB_RUNNER_EXIT_AFTER_MS) setTimeout(() => { console.error("runner: CAW_WORKSPACE_ROOT is not set: the absolute path of ai-agent-workspace"); process.exit(1); }, Number(process.env.STUB_RUNNER_EXIT_AFTER_MS));
else setInterval(() => {}, 1000);
`;

/** `apiAlreadyUp`: something already answers on the port before dev.ts starts — a CAW API (`/health` → { ok: true }) or some other program (200 "hello") */
async function startDev(extra: Record<string, string> = {}, opts: { apiAlreadyUp?: "caw" | "other" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "caw-dev-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "api.ts"), API_STUB);
  writeFileSync(join(dir, "runner.ts"), RUNNER_STUB);
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  if (opts.apiAlreadyUp) {
    const already = Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => (opts.apiAlreadyUp === "caw" && new URL(req.url).pathname === "/health" ? Response.json({ ok: true }) : new Response("hello")) });
    cleanups.push(() => already.stop(true));
  }
  const proc = Bun.spawn([process.execPath, "--no-env-file", "src/dev.ts"], {
    cwd: ROOT, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CAW_DEV_API_ENTRY: join(dir, "api.ts"), CAW_DEV_RUNNER_ENTRY: join(dir, "runner.ts"), PORT: String(port), CAW_MARK: "same-env", ...extra },
  });
  const pids: number[] = [];
  cleanups.push(() => {
    for (const p of pids) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
    // whatever still listens on OUR port (the real API, when a test started it) — found by port, never by name
    const listeners = Bun.spawnSync(["lsof", `-tiTCP:${port}`, "-sTCP:LISTEN"]).stdout.toString().split("\n").filter(Boolean).map(Number).filter((p) => p !== process.pid); // never this test process: it hosts the "already up" stub
    for (const p of listeners) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  });
  const lines: string[] = [];
  for (const stream of [proc.stdout, proc.stderr]) {
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        lines.push(...parts);
      }
      if (buf) lines.push(buf);
    })();
  }
  const pidOf = (prefix: string) => { const l = lines.find((x) => x.startsWith(`${prefix} `) && x.includes(" pid ")); return l ? Number(/pid (\d+)/.exec(l)![1]) : 0; };
  const started = async () => {
    const apiPid = await until("the api stub", () => pidOf("[api]"));
    const runnerPid = await until("the runner stub", () => pidOf("[runner]"));
    pids.push(apiPid, runnerPid);
    return { apiPid, runnerPid };
  };
  return { proc, lines, port, started };
}

test("both children start with the same environment, and every line carries its prefix", async () => {
  const d = await startDev();
  const { apiPid, runnerPid } = await d.started();
  expect(d.lines).toContain(`[api] api pid ${apiPid} mark=same-env`);
  expect(d.lines).toContain(`[runner] runner pid ${runnerPid} mark=same-env`); // CAW_MARK reached both
  expect(apiPid).not.toBe(runnerPid);
  expect(d.lines.every((l) => l.startsWith("[api] ") || l.startsWith("[runner] "))).toBe(true);
  expect(await (await fetch(`http://127.0.0.1:${d.port}`)).text()).toBe("api ok"); // the API is serving on the shared PORT
});

test("the runner exits (here: its own 'CAW_WORKSPACE_ROOT is not set' line) → `[runner] stopped: <its last line>` is printed and the API stays up; the runner is NOT restarted", async () => {
  const d = await startDev({ STUB_RUNNER_EXIT_AFTER_MS: "300" });
  const { apiPid } = await d.started();
  const stopped = await until("the stopped line", () => d.lines.find((l) => l.startsWith("[runner] stopped:")));
  expect(stopped).toBe("[runner] stopped: runner: CAW_WORKSPACE_ROOT is not set: the absolute path of ai-agent-workspace"); // the runner's own last line, after the prefix
  expect(await (await fetch(`http://127.0.0.1:${d.port}`)).text()).toBe("api ok"); // still answering
  expect(d.proc.exitCode).toBeNull(); // dev.ts itself is still running
  expect(alive(apiPid)).toBe(true);
  await sleep(1200); // a restart would show a second "runner pid" line by now
  expect(d.lines.filter((l) => l.includes("runner pid"))).toHaveLength(1);
  expect(d.lines.filter((l) => l.startsWith("[runner] stopped:"))).toHaveLength(1);
});

test("SIGINT stops both children and dev.ts exits; no child is left (checked by pid)", async () => {
  const d = await startDev();
  const { apiPid, runnerPid } = await d.started();
  d.proc.kill("SIGINT");
  await Promise.race([d.proc.exited, sleep(8000).then(() => { throw new Error("dev.ts did not exit after SIGINT"); })]);
  await until("both children gone", () => !alive(apiPid) && !alive(runnerPid));
  expect(alive(apiPid) || alive(runnerPid)).toBe(false);
});

test("SIGTERM does the same", async () => {
  const d = await startDev();
  const { apiPid, runnerPid } = await d.started();
  d.proc.kill("SIGTERM");
  await Promise.race([d.proc.exited, sleep(8000).then(() => { throw new Error("dev.ts did not exit after SIGTERM"); })]);
  await until("both children gone", () => !alive(apiPid) && !alive(runnerPid));
});

test("after the runner has stopped, SIGINT still stops the API and dev.ts exits", async () => {
  const d = await startDev({ STUB_RUNNER_EXIT_AFTER_MS: "200" });
  const { apiPid } = await d.started();
  await until("the stopped line", () => d.lines.find((l) => l.startsWith("[runner] stopped:")));
  d.proc.kill("SIGINT");
  await Promise.race([d.proc.exited, sleep(8000).then(() => { throw new Error("dev.ts did not exit"); })]);
  await until("the api gone", () => !alive(apiPid));
});

test("the API exits → the runner is stopped and dev.ts exits with the API's code", async () => {
  const d = await startDev({ STUB_API_EXIT_AFTER_MS: "300", STUB_API_EXIT_CODE: "3", CAW_DEV_API_EARLY_MS: "50" }); // 50 ms: the exit at ~300 ms is NOT an early one
  const { runnerPid } = await d.started();
  const code = await Promise.race([d.proc.exited, sleep(8000).then(() => { throw new Error("dev.ts did not exit after the API did"); })]);
  expect(code).toBe(3);
  await until("the runner gone", () => !alive(runnerPid));
  expect(d.lines).toContain("[api] api bye");
});

test("the REAL API (src/index.ts, in-memory database) prints one start line that dev.ts prefixes — `[api] caw-back API on http://127.0.0.1:<port>` — and never the database URL", async () => {
  // CAW_DEV_API_ENTRY empty → dev.ts falls back to the real src/index.ts; the runner is still a stub
  const d = await startDev({ CAW_DEV_API_ENTRY: "", DATABASE_URL: "pglite:memory", CAW_POLL_MS: "0", BLUEPRINT_URL: "http://127.0.0.1:1" });
  const line = await until("the API's start line", () => d.lines.find((l) => l.startsWith("[api] caw-back API on ")), 20000);
  expect(line).toBe(`[api] caw-back API on http://127.0.0.1:${d.port}`);
  expect(d.lines.some((l) => l.includes("pglite") || l.includes("DATABASE_URL"))).toBe(false); // the URL may hold a password: never printed
  expect(await (await fetch(`http://127.0.0.1:${d.port}/health`)).json()).toEqual({ ok: true }); // and it really is serving there
  d.proc.kill("SIGINT");
  await Promise.race([d.proc.exited, sleep(10000).then(() => { throw new Error("dev.ts did not exit"); })]);
  await until("the port free", async () => { try { await fetch(`http://127.0.0.1:${d.port}/health`); return false; } catch { return true; } }, 5000).catch(() => undefined);
}, 40000);

// ---- TASK-A-096 / SPEC-A-009 § Revision 3 (D-103 DEF-1): the shown command is `bun run runner`, and dev.ts is tolerant of an API that is already up ----

test("an API already answers /health on the port → `[dev] an API already answers on :<port> — starting the runner only`; ONE child (the runner), no API started; dev exits with the runner's code", async () => {
  const d = await startDev({ STUB_RUNNER_EXIT_AFTER_MS: "700" }, { apiAlreadyUp: "caw" });
  const runnerPid = await until("the runner stub", () => { const l = d.lines.find((x) => x.startsWith("[runner] ") && x.includes(" pid ")); return l ? Number(/pid (\d+)/.exec(l)![1]) : 0; });
  expect(d.lines).toContain(`[dev] an API already answers on :${d.port} — starting the runner only`);
  expect(d.lines.some((l) => l.startsWith("[api]"))).toBe(false); // the API stub was never started
  expect(alive(runnerPid)).toBe(true);
  const code = await Promise.race([d.proc.exited, sleep(8000).then(() => { throw new Error("dev.ts did not exit when its runner did"); })]);
  expect(code).toBe(1); // the runner stub exits 1 — dev.ts exits with the runner's code
  expect(d.lines).toContain("[runner] stopped: runner: CAW_WORKSPACE_ROOT is not set: the absolute path of ai-agent-workspace");
});

test("with an API already up, SIGINT stops the runner and dev.ts exits (the other program's API is not touched)", async () => {
  const d = await startDev({}, { apiAlreadyUp: "caw" });
  const runnerPid = await until("the runner stub", () => { const l = d.lines.find((x) => x.startsWith("[runner] ") && x.includes(" pid ")); return l ? Number(/pid (\d+)/.exec(l)![1]) : 0; });
  d.proc.kill("SIGINT");
  await Promise.race([d.proc.exited, sleep(8000).then(() => { throw new Error("dev.ts did not exit"); })]);
  await until("the runner gone", () => !alive(runnerPid));
  expect(await (await fetch(`http://127.0.0.1:${d.port}/health`)).json()).toEqual({ ok: true }); // the API that was already there still answers
});

test("the API child exits within 5 s of its start (a race, or a non-CAW program on the port) → `[api] could not start (port in use?) — runner kept`; the runner stays alive and is never restarted", async () => {
  const d = await startDev({ STUB_API_EXIT_AFTER_MS: "100", STUB_API_EXIT_CODE: "1" });
  const { runnerPid } = await d.started();
  await until("the could-not-start line", () => d.lines.find((l) => l === "[api] could not start (port in use?) — runner kept"));
  await sleep(1200);
  expect(alive(runnerPid)).toBe(true);
  expect(d.proc.exitCode).toBeNull(); // dev.ts is still running, with its runner
  expect(d.lines.filter((l) => l.includes("runner pid"))).toHaveLength(1); // no restart
  expect(d.lines.some((l) => l.startsWith("[runner] stopped:"))).toBe(false);
  d.proc.kill("SIGINT");
  await Promise.race([d.proc.exited, sleep(8000).then(() => { throw new Error("dev.ts did not exit"); })]);
  await until("the runner gone", () => !alive(runnerPid));
});

test("when the API could not start and the runner then stops too, nothing is left: dev.ts prints the stopped line and exits with the runner's code", async () => {
  const d = await startDev({ STUB_API_EXIT_AFTER_MS: "100", STUB_API_EXIT_CODE: "1", STUB_RUNNER_EXIT_AFTER_MS: "900" });
  await d.started();
  const code = await Promise.race([d.proc.exited, sleep(8000).then(() => { throw new Error("dev.ts did not exit"); })]);
  expect(code).toBe(1);
  expect(d.lines).toContain("[api] could not start (port in use?) — runner kept");
  expect(d.lines.find((l) => l.startsWith("[runner] stopped:"))).toBeString();
});

test("a NON-CAW program already on the port (200 \"hello\", not { ok: true }) is not taken for the API: dev.ts tries to start its own, which cannot bind — and the runner is kept", async () => {
  const d = await startDev({ CAW_DEV_API_EARLY_MS: "5000" }, { apiAlreadyUp: "other" });
  const runnerPid = await until("the runner stub", () => { const l = d.lines.find((x) => x.startsWith("[runner] ") && x.includes(" pid ")); return l ? Number(/pid (\d+)/.exec(l)![1]) : 0; });
  expect(d.lines.some((l) => l.startsWith("[dev] an API already answers"))).toBe(false);
  await until("the could-not-start line", () => d.lines.find((l) => l === "[api] could not start (port in use?) — runner kept"));
  expect(alive(runnerPid)).toBe(true);
  d.proc.kill("SIGINT");
  await Promise.race([d.proc.exited, sleep(8000).then(() => { throw new Error("dev.ts did not exit"); })]);
});
