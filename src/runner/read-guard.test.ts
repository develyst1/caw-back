// The read guard (TASK-C-042 Part A, UP-3): a PreToolUse hook for Read | Glob | Grep that refuses any path outside the hop's readable folders.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guard, runGuardCli } from "./read-guard";

const made: string[] = [];
const tmp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const root = tmp("rg-root-");     // a readable root
const hopDir = tmp("rg-hop-");    // the hop's private folder (readable)
const outside = tmp("rg-out-");   // a folder that is NOT readable
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "ok");
writeFileSync(join(outside, "canary.txt"), "CANARY-7Q");
symlinkSync(outside, join(root, "link-out"));              // inside the root, pointing outside
symlinkSync(join(root, "src"), join(root, "link-in"));      // inside the root, pointing inside
const dirs = [root, hopDir];
const read = (file_path: string, cwd = root) => guard({ tool_name: "Read", tool_input: { file_path }, cwd }, dirs);
const glob = (input: Record<string, unknown>, cwd = root) => guard({ tool_name: "Glob", tool_input: input, cwd }, dirs);
const grep = (input: Record<string, unknown>, cwd = root) => guard({ tool_name: "Grep", tool_input: input, cwd }, dirs);

describe("guard — what is allowed", () => {
  test("a file inside a root, and inside the hop's private folder", () => {
    expect(read(join(root, "src", "a.ts"))).toBeNull();
    expect(read(join(hopDir, "mcp.json"))).toBeNull();
  });
  test("the root itself", () => { expect(glob({ path: root, pattern: "*" })).toBeNull(); });
  test("a relative path is resolved against the cwd", () => {
    expect(read("src/a.ts")).toBeNull();
    expect(read("./src/../src/a.ts")).toBeNull();
  });
  test("Glob and Grep without a path default to the cwd (inside → allowed)", () => {
    expect(glob({ pattern: "**/*.ts" })).toBeNull();
    expect(grep({ pattern: "foo" })).toBeNull();
  });
  test("a symlink inside a root that points inside is fine", () => { expect(read(join(root, "link-in", "a.ts"))).toBeNull(); });
  test("a file that does not exist yet, under a readable folder", () => { expect(read(join(root, "src", "new", "x.ts"))).toBeNull(); });
  test("other tools are not its business", () => { expect(guard({ tool_name: "Bash", tool_input: { command: "cat /etc/passwd" }, cwd: root }, dirs)).toBeNull(); });
});

describe("guard — what is refused, with a one-line reason", () => {
  test("a file outside every readable folder", () => {
    const why = read(join(outside, "canary.txt"));
    expect(why).toContain(join(outside, "canary.txt"));
    expect(why).not.toContain("\n");
  });
  test("a `../` escape out of a root", () => {
    expect(read(join(root, "..", "etc", "passwd"))).not.toBeNull();
    expect(read(`${root}/src/../../../../etc/passwd`)).not.toBeNull();
  });
  test("a symlink inside a root pointing OUTSIDE is refused (the real path decides)", () => {
    expect(read(join(root, "link-out", "canary.txt"))).not.toBeNull();
    expect(glob({ path: join(root, "link-out"), pattern: "*" })).not.toBeNull();
  });
  test("a relative path that climbs out of the cwd", () => { expect(read("../../../../etc/passwd")).not.toBeNull(); });
  test("the cwd itself outside: a Glob / Grep without a path is refused", () => {
    expect(glob({ pattern: "*" }, outside)).not.toBeNull();
    expect(grep({ pattern: "x" }, outside)).not.toBeNull();
  });
  test("an ABSOLUTE Glob pattern outside, with and without a path argument", () => {
    expect(glob({ pattern: `${outside}/*` })).not.toBeNull();
    expect(glob({ pattern: `${outside}/**/*.txt` })).not.toBeNull();
    expect(glob({ path: root, pattern: `${outside}/*` })).not.toBeNull();
  });
  test("an absolute Grep `glob` outside; a Grep `path` outside", () => {
    expect(grep({ pattern: "CANARY", glob: `${outside}/*.txt` })).not.toBeNull();
    expect(grep({ pattern: "CANARY", path: outside })).not.toBeNull();
  });
  test("an absolute Glob pattern INSIDE is fine; its static prefix is what counts", () => {
    expect(glob({ pattern: `${root}/src/**/*.ts` })).toBeNull();
    expect(glob({ pattern: `${root}/../*` })).not.toBeNull();
  });
  test("`~` means the home directory, which is not readable unless a root is under it", () => {
    expect(read("~/caw-canary-c042/canary.txt")).not.toBeNull();
  });
  test("the Grep regex `pattern` is not a path: a pattern that looks like one does not refuse an inside search", () => {
    expect(grep({ pattern: "/etc/passwd", path: root })).toBeNull();
  });
  test("a Read with no file_path, or a payload that is not an object, is refused (fail closed)", () => {
    expect(guard({ tool_name: "Read", tool_input: {}, cwd: root }, dirs)).not.toBeNull();
    expect(guard(null as any, dirs)).not.toBeNull();
  });
});

describe("runGuardCli — the hook's contract: exit 0 to allow, exit 2 and a reason on stderr to block", () => {
  const payload = (input: object) => JSON.stringify({ tool_name: "Read", tool_input: input, cwd: root });
  test("allowed → 0", () => { expect(runGuardCli([JSON.stringify(dirs)], payload({ file_path: join(root, "src", "a.ts") }))).toEqual({ code: 0, stderr: "" }); });
  test("outside → 2 with the reason", () => {
    const r = runGuardCli([JSON.stringify(dirs)], payload({ file_path: join(outside, "canary.txt") }));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("outside");
  });
  test("bad stdin → 2, bad or missing dirs argument → 2 (never fail open)", () => {
    expect(runGuardCli([JSON.stringify(dirs)], "not json").code).toBe(2);
    expect(runGuardCli([], payload({ file_path: join(root, "src", "a.ts") })).code).toBe(2);
    expect(runGuardCli(["not json"], payload({ file_path: join(root, "src", "a.ts") })).code).toBe(2);
    expect(runGuardCli(["[]"], payload({ file_path: join(root, "src", "a.ts") })).code).toBe(2);
  });
});
