// TASK-A-094 / SPEC-A-009 § R3a + Revision 1 (REQ-015 AC-3, D-098): the core takes machine paths out of worker-written text. Two rewrites, in order:
// (1) each project root → its D-098 name (the last path segment, or `parent/last` when two roots share a last segment), longest root first;
// (2) any other `/Users/<name>/` or `/home/<name>/` prefix → `~/`. Pure — it knows nothing of actors; `rewriteForActor` applies it to workers only.
import { expect, test } from "bun:test";
import { folderNames, rewriteForActor, rewritePaths } from "../../src/core/paths";

const ROOTS = ["/Users/x/w/mc2-front", "/Users/x/w/mc2-front-api"];

test("a root becomes its last segment, and longest root first: mc2-front-api is not eaten by the shorter root mc2-front", () => {
  expect(rewritePaths("/Users/x/w/mc2-front/src/a.ts", ROOTS)).toBe("mc2-front/src/a.ts");
  expect(rewritePaths("/Users/x/w/mc2-front-api/src/a.ts", ROOTS)).toBe("mc2-front-api/src/a.ts");
  expect(rewritePaths("ดู /Users/x/w/mc2-front-api/src/a.ts กับ /Users/x/w/mc2-front/lib/b.dart ด้วย", ROOTS)).toBe("ดู mc2-front-api/src/a.ts กับ mc2-front/lib/b.dart ด้วย");
  expect(rewritePaths("/Users/x/w/mc2-front-api/src/a.ts", ROOTS.slice().reverse())).toBe("mc2-front-api/src/a.ts"); // the order of the list does not matter
});

test("nested roots: the longest wins — with /Users/x/w AND /Users/x/w/app, a path in app is named app/…, a path elsewhere in w is named w/…", () => {
  const roots = ["/Users/x/w", "/Users/x/w/app"];
  expect(rewritePaths("/Users/x/w/app/src/a.ts", roots)).toBe("app/src/a.ts");
  expect(rewritePaths("/Users/x/w/app/src/a.ts", roots.slice().reverse())).toBe("app/src/a.ts");
  expect(rewritePaths("/Users/x/w/other/b.ts and /Users/x/w/app/c.ts", roots)).toBe("w/other/b.ts and app/c.ts");
});

test("the boundary: a root is not a prefix of a longer name — with only mc2-front configured, mc2-front-api and mc2-front.bak are other paths (→ ~/)", () => {
  expect(rewritePaths("/Users/x/w/mc2-front-api/src", [ROOTS[0]!])).toBe("~/w/mc2-front-api/src");
  expect(rewritePaths("/Users/x/w/mc2-front.bak/x", [ROOTS[0]!])).toBe("~/w/mc2-front.bak/x");
  expect(rewritePaths("/Users/x/w/mc2-front2/x", [ROOTS[0]!])).toBe("~/w/mc2-front2/x");
});

test("D-098: two roots with the same last segment are named parent/last", () => {
  const roots = ["/Users/x/a/usb-oda", "/Users/x/b/usb-oda"];
  expect([...folderNames(roots).entries()]).toEqual([["/Users/x/a/usb-oda", "a/usb-oda"], ["/Users/x/b/usb-oda", "b/usb-oda"]]);
  expect(rewritePaths("/Users/x/a/usb-oda/lib/main.dart และ /Users/x/b/usb-oda/lib/main.dart", roots)).toBe("a/usb-oda/lib/main.dart และ b/usb-oda/lib/main.dart");
  expect(folderNames(ROOTS).get(ROOTS[0]!)).toBe("mc2-front"); // distinct last segments: just the last
});

test("D-098: roots that still collide on parent/last get no name — they fall to the home-prefix rule, never to one shared name", () => {
  const roots = ["/Users/x/a/p/repo", "/Users/x/b/p/repo"];
  expect(folderNames(roots).size).toBe(0);
  expect(rewritePaths("/Users/x/a/p/repo/src", roots)).toBe("~/a/p/repo/src");
});

test("any other /Users/<name>/ or /home/<name>/ prefix becomes ~/ (AC-3: no /Users/ left)", () => {
  expect(rewritePaths("/Users/x/other/b.md", ROOTS)).toBe("~/other/b.md");
  expect(rewritePaths("ดูที่ /home/somchai/projects/app/readme.md", [])).toBe("ดูที่ ~/projects/app/readme.md");
  expect(rewritePaths("cd /Users/x.y-z/work && ls", [])).toBe("cd ~/work && ls");
  expect(rewritePaths("my home is /Users/x.", [])).toBe("my home is ~."); // the bare home dir; the sentence's full stop is not part of the name
  expect(rewritePaths("(/Users/x/a.txt)", [])).toBe("(~/a.txt)");
});

test("a root at the end of a sentence, in quotes, backticks or a fence is rewritten; a trailing slash on the root is ignored", () => {
  expect(rewritePaths("โฟลเดอร์คือ /Users/x/w/mc2-front.", ROOTS)).toBe("โฟลเดอร์คือ mc2-front.");
  expect(rewritePaths("`/Users/x/w/mc2-front`", ROOTS)).toBe("`mc2-front`");
  expect(rewritePaths('"/Users/x/w/mc2-front/src"', ROOTS)).toBe('"mc2-front/src"');
  expect(rewritePaths("```sh\ncd /Users/x/w/mc2-front-api\nls /Users/x/other\n```", ROOTS)).toBe("```sh\ncd mc2-front-api\nls ~/other\n```"); // inside a fence too
  expect(rewritePaths("/Users/x/w/mc2-front/src", ["/Users/x/w/mc2-front/"])).toBe("mc2-front/src");
});

test("text without a machine path is returned byte for byte (Thai, URLs, relative and /tmp paths, words that merely contain Users or home)", () => {
  for (const t of ["", "สวัสดีครับ ไม่มีพาธ", "https://example.com/Users/x/page and https://site.dev/home/page/", "/tmp/x and ./src/a.ts and ../b", "Users/x/y (no leading slash)", "the Users and home directories", "/etc/hosts"]) {
    expect(rewritePaths(t, ROOTS)).toBe(t);
  }
});

test("idempotent: rewriting a rewritten text changes nothing; every occurrence is rewritten, not just the first", () => {
  const once = rewritePaths("/Users/x/w/mc2-front/a /Users/x/w/mc2-front/b /Users/x/o/c /home/y/d", ROOTS);
  expect(once).toBe("mc2-front/a mc2-front/b ~/o/c ~/d");
  expect(rewritePaths(once, ROOTS)).toBe(once);
});

test("Windows roots are named by their last segment too (the workspace allows C:\\… roots)", () => {
  expect(rewritePaths("C:\\work\\app\\src\\a.ts and D:/work/web/x", ["C:\\work\\app", "D:/work/web"])).toBe("app\\src\\a.ts and web/x");
});

test("rewriteForActor: a worker's text is rewritten, the operator's and a runner's never", () => {
  const t = "/Users/x/w/mc2-front/src and /Users/x/other/b.md";
  expect(rewriteForActor("worker:00000000-0000-4000-8000-000000000001", t, ROOTS)).toBe("mc2-front/src and ~/other/b.md");
  expect(rewriteForActor("operator", t, ROOTS)).toBe(t);
  expect(rewriteForActor("runner:r1", t, ROOTS)).toBe(t);
});
