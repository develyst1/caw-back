// SPEC-108 D2: what a worker may run in Bash. One test per row of the table, both directions, plus the cases the TASK names and a few evasions.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeBash } from "./bash-policy";

const made: string[] = [];
const tmp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const root = tmp("bp-root-");        // a readable, writable project folder (the cwd)
const spec = tmp("bp-spec-");        // a second readable folder that is READ-ONLY
const outside = tmp("bp-out-");      // not readable
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "ok");
writeFileSync(join(spec, "spec.md"), "spec");
writeFileSync(join(outside, "canary.txt"), "CANARY");
symlinkSync(outside, join(root, "link-out"));
const readable = [root, spec];
const readOnly = [spec];
const judge = (c: string, cwd = root) => judgeBash(c, cwd, readable, readOnly);
const ok = (c: string, cwd = root) => expect([c, judge(c, cwd)]).toEqual([c, null]);
const refused = (c: string, code: string, cwd = root) => { const r = judge(c, cwd); expect([c, r?.code]).toEqual([c, code]); return r!; };

describe("allowed: the read programs", () => {
  test("pwd ls cat head tail grep wc diff sort uniq file stat du tree which echo printf true sleep date basename dirname realpath", () => {
    for (const c of ["pwd", "ls", "ls -la src", "cat src/a.ts", "head -5 src/a.ts", "tail -n 3 src/a.ts", "grep -rn foo src", "wc -l src/a.ts", "diff src/a.ts src/a.ts", "sort src/a.ts", "uniq src/a.ts",
      "file src/a.ts", "stat src/a.ts", "du -sh .", "tree src", "which bun", "echo hello", "printf 'a\\n'", "true", "sleep 1", "date", "basename src/a.ts", "dirname src/a.ts", "realpath src/a.ts"]) {
      if (c.includes("\\")) continue; // printf with a backslash is a shell feature by design (below)
      ok(c);
    }
  });
  test("a read program may read a read-only folder (reading is the point of it)", () => { ok(`cat ${join(spec, "spec.md")}`); ok(`ls ${spec}`); });
  test("a read program outside the folders → outside, with the real path as the detail", () => {
    const r = refused("cat /etc/hosts", "outside");
    expect(r.detail).toBe("/etc/hosts");
    refused("ls /", "outside"); refused("cat ~/.ssh/id_rsa", "outside"); refused("cat ../../etc/passwd", "outside"); refused("grep -r x /home", "outside");
  });
});

describe("allowed: the write programs (cwd and every path word writable)", () => {
  // was: "mkdir touch cp mv rm chmod tee sed in a writable folder" (with `sed -n 1p`). F2 (TASK-118 rework): sed is not a write program any more — see "F2" below.
  test("mkdir touch cp mv rm chmod tee in a writable folder", () => {
    for (const c of ["mkdir -p newdir", "touch newfile", "cp src/a.ts src/b.ts", "mv src/a.ts src/c.ts", "rm src/a.ts", "chmod +x src/a.ts", "tee out.txt"]) ok(c);
  });
  test("a path word in a read-only folder → read_only, with that path", () => {
    const r = refused(`rm -r ${join(spec, "x")}`, "read_only");
    expect(r.detail).toBe(join(spec, "x"));
    refused(`touch ${join(spec, "new.md")}`, "read_only"); refused(`cp src/a.ts ${spec}/`, "read_only"); refused(`tee ${join(spec, "spec.md")}`, "read_only"); // was `sed -i s/a/b/ <spec>` → read_only; sed is not_allowed now (F2)
  });
  test("the cwd itself read-only → read_only for every write program, and for bun / node", () => {
    for (const c of ["touch x", "mkdir y", "rm z", "bun test", "node a.js"]) refused(c, "read_only", spec);
    ok("ls", spec); ok("cat spec.md", spec); // reading there is fine
  });
  test("a NEW file with a directory part in a read-only folder is a write there (it does not exist yet, so it is not 'an existing name')", () => {
    const ro = [join(root, "src")];
    const j = (c: string) => judgeBash(c, root, [root], ro);
    for (const c of ["touch src/new.ts", "mkdir src/sub/deeper", "cp a.txt src/b.txt", "tee src/out.txt", "mv x src/y"]) expect([c, j(c)?.code]).toEqual([c, "read_only"]);
    expect(j("touch newfile")).toBeNull();           // no directory part: the cwd (writable) is the place
    expect(j("cat src/not-yet.ts")).toBeNull();      // a READ of a name that does not exist is not a write
  });
  test("a path outside → outside (cp a /tmp/x)", () => { refused("cp a /tmp/x", "outside"); refused(`mv src/a.ts ${outside}/`, "outside"); });
});

describe("find", () => {
  test("allowed; -exec -execdir -ok -okdir (and -delete, -fprint*) refused → not_allowed", () => {
    ok("find . -name '*.ts'"); ok("find src -type f");
    for (const a of ["-exec ls", "-execdir ls", "-ok ls", "-okdir ls", "-delete", "-fprint out.txt", "-fls out.txt"]) refused(`find . ${a}`, "not_allowed");
    expect(refused("find . -exec ls", "not_allowed").detail).toBe("find -exec");
    refused("find . -exec rm {} ;", "shell_feature"); // the usual spelling is a shell feature first (braces)
    refused("find / -name x", "outside");
  });
});

describe("git: read only", () => {
  test("status log diff show ls-files blame rev-parse are allowed", () => {
    for (const c of ["git status", "git status --short", "git log --oneline -5", "git diff", "git diff HEAD~1 -- src", "git show HEAD", "git ls-files", "git blame src/a.ts", "git rev-parse HEAD", "git --no-pager log"]) ok(c);
  });
  test("any other subcommand → git_write (commit add push checkout reset …), the detail is the subcommand", () => {
    for (const s of ["commit -m x", "add .", "push", "checkout main", "reset --hard", "branch x", "tag v1", "stash", "rebase", "clean -fd", "config user.name x", "worktree add ../w", "apply p.diff"]) refused(`git ${s}`, "git_write");
    expect(refused("git commit -m x", "git_write").detail).toBe("commit");
  });
  test("--output is a file write → git_write; -c (config override) → git_write; -C <dir> is judged as a path", () => {
    refused("git diff --output=out.txt", "git_write"); refused("git log --output out.txt", "git_write"); refused("git -c core.pager=x log", "git_write");
    refused("git -C /etc status", "outside"); ok(`git -C ${root} status`);
  });
});

describe("bun, bunx, node", () => {
  test("install add build run test x and the like are allowed (the registry is reached by nature); --version too", () => {
    for (const c of ["bun --version", "bun install", "bun add zod", "bun build ./index.ts --outdir ./dist", "bun run server.ts", "bun test src/a.test.ts", "bunx tsc --noEmit", "node a.js", "bun x tsc"]) ok(c);
  });
  test("code on the command line → inline_code: -e --eval -p --print (also the =forms)", () => {
    for (const c of ["bun -e 1", "bun --eval 1", "bun -p 1", "bun --print 1", "node -e 1", "node --eval=1", "node -p 1", "node --print=1", "bunx -e 1"]) refused(c, "inline_code");
    expect(refused("node -e 1", "inline_code").detail).toBe("-e");
  });
  test("bun publish → not_allowed; a path word outside → outside; in a read-only folder → read_only", () => {
    expect(refused("bun publish", "not_allowed").detail).toBe("bun publish");
    refused("bun run /etc/x.ts", "outside"); refused(`bun run ${join(spec, "x.ts")}`, "read_only");
  });
});

describe("curl, wget: only the machine itself", () => {
  test("127.0.0.1, localhost and [::1], with any port, scheme or path → allowed", () => {
    for (const c of ["curl -s http://127.0.0.1:3900/", "curl http://localhost:4500/health", "curl -s http://[::1]:8080/x?y=1", "curl 127.0.0.1:3000", "wget -q http://127.0.0.1/",
      "curl -s -X POST -H 'content-type: application/json' -d 'x' http://localhost:3900/api"]) ok(c);
    ok(`curl -s -H 'accept: json' -X POST -d '{"a":1}' http://127.0.0.1:3900/api`); // a JSON body in single quotes is one value word
  });
  test("any other host → network, the detail is the word", () => {
    expect(refused("curl https://example.com", "network").detail).toBe("https://example.com");
    refused("curl http://127.0.0.1.evil.com/", "network"); refused("curl http://localhost.evil.com/", "network"); refused("curl http://user@evil.com/", "network");
    refused("wget http://example.com/x", "network"); refused("curl http://127.0.0.1/ http://example.com/", "network"); refused("curl example.com", "network");
  });
  test("-K / --config, a proxy, wget -i / -e are not judgeable → network", () => {
    for (const c of ["curl -K cfg http://127.0.0.1/", "curl --config cfg", "curl -x http://p:1 http://127.0.0.1/", "curl --proxy http://p:1 http://127.0.0.1/", "wget -i urls.txt", "wget -e use_proxy=on http://127.0.0.1/", "wget --execute x http://127.0.0.1/"]) refused(c, "network");
  });
  test("a value option swallows its value, a FLAG does not: curl -c takes a value, wget -c does not (so wget -c <url> is still judged)", () => {
    ok("curl -s -c jar.txt http://127.0.0.1:3000/");
    refused("wget -c http://example.com/x", "network"); refused("wget -r http://example.com/", "network"); refused("wget -H http://example.com/", "network"); refused("wget -b http://example.com/", "network");
    refused("curl -s -- http://example.com/", "network");
  });
  test("an output file is a write path; @file in data is a read path", () => {
    ok("curl -s -o out.txt http://127.0.0.1:3000/");
    refused("curl -s -o /tmp/x http://127.0.0.1:3000/", "outside"); refused(`curl -s -o ${join(spec, "x")} http://127.0.0.1:3000/`, "read_only");
    refused("curl -s -d @/etc/passwd http://127.0.0.1:3000/", "outside"); ok("curl -s -d @src/a.ts http://127.0.0.1:3000/");
  });
});

describe("never: nc ncat ssh scp sftp rsync telnet ftp → network; anything else → not_allowed", () => {
  test("the network programs", () => { for (const p of ["nc", "ncat", "ssh", "scp", "sftp", "rsync", "telnet", "ftp"]) refused(`${p} host 1`, "network"); });
  test("everything not on the list, a path as a program, an env prefix, cd", () => {
    for (const c of ["docker ps", "python3 x.py", "sh -c ls", "bash", "make", "npm install", "cd src", "FOO=1 ls", "./run.sh", "/bin/ls", "sudo ls", "kill 1", "env", "xargs ls"]) refused(c, "not_allowed");
    expect(refused("docker ps", "not_allowed").detail).toBe("docker");
  });
});

describe("shell syntax", () => {
  test("&& || ; | between commands are allowed, each command judged on its own", () => {
    for (const c of ["pwd && ls -la", "ls || echo none", "pwd ; ls", "cat src/a.ts | head -5", "bun run server.ts 2>&1 | head -20", "git status && git diff | wc -l"]) ok(c);
    refused("ls && docker ps", "not_allowed"); refused("ls | nc host 1", "network"); refused("pwd ; cat /etc/hosts", "outside"); refused("ls && git commit -m x", "git_write");
  });
  test("the allowed redirects: > >> 2> 2>> &> + a path (a write), < + a path (a read), 2>&1, >&2, /dev/null", () => {
    for (const c of ["ls > out.txt", "ls >> out.txt", "ls 2> err.txt", "ls 2>> err.txt", "ls &> all.txt", "cat < src/a.ts", "ls 2>&1", "echo x >&2", "ls 2>/dev/null", "ls > /dev/null 2>&1", "bun test 2>&1"]) ok(c);
    refused("ls > /etc/x", "outside"); refused(`ls >> ${join(spec, "log")}`, "read_only"); refused("cat < /etc/passwd", "outside"); refused("ls 2> /tmp/e", "outside");
  });
  test("refused outside single quotes: $ ` \\ ( ) { } newline, a lone & , << → shell_feature, the detail is the character", () => {
    for (const [c, d] of [["echo $HOME", "$"], ["echo `ls`", "`"], ["echo $(ls)", "$"], ["echo a\\b", "\\"], ["(ls)", "("], ["echo {a,b}", "{"], ["ls\nrm x", "newline"], ["bun run x &", "&"], ["cat <<EOF", "<<"], ["cat <<< x", "<<"],
      ["echo \"$HOME\"", "$"], ["echo \"a (b)\"", "("], ["ls >&3", ">&"], ["ls >", ">"], ["&& ls", "&&"], ["ls &&", "&&"], ["ls ; ; ls", ";"], ["echo 'unclosed", "'"]] as const) {
      expect([c, judge(c)?.code, judge(c)?.detail]).toEqual([c, "shell_feature", d]);
    }
  });
  test("single quotes protect everything inside them: grep 'a|b' src, echo 'a && b', grep 'foo$' src; double quotes group but still refuse $", () => {
    ok("grep -rn 'a|b' src"); ok("echo 'a && b; c'"); ok("grep 'foo$' src"); ok("echo \"a && b\""); ok("echo \"hello world\"");
  });
});

describe("paths: judged by where they REALLY land", () => {
  test("a symlink inside the folder that points outside → outside; one that points inside is fine", () => {
    refused("cat link-out/canary.txt", "outside"); refused("ls link-out", "outside");
    symlinkSync(join(root, "src"), join(root, "link-in"));
    ok("cat link-in/a.ts");
  });
  test("options can carry a path: --file=/etc/passwd, -f/etc/passwd, --exclude-from=~/.bashrc", () => {
    for (const c of ["grep --file=/etc/passwd x", "grep -f/etc/passwd x", "grep --exclude-from=~/.bashrc x src"]) refused(c, "outside");
  });
  test("a '..' that stays inside is fine; one that climbs out is refused; the cwd decides relative words", () => {
    ok("cat src/../src/a.ts"); refused("cat ../x", "outside");
    ok("cat a.ts", join(root, "src")); refused("cat canary.txt", "outside", outside);
  });
  test("quoted words are one word; a word that is not a path is left alone", () => { ok('cat "src/a.ts"'); ok("grep -rn 'foo bar' src"); ok("echo notapath/with/slashes"); });
});

describe("the TASK's listed cases", () => {
  test("allowed: pwd && ls -la · bun --version · bun install · bun build … · bun run server.ts 2>&1 | head -20 · grep -rn 'a|b' src · curl -s http://127.0.0.1:3900/", () => {
    for (const c of ["pwd && ls -la", "bun --version", "bun install", "bun build ./index.ts --outdir ./dist", "bun run server.ts 2>&1 | head -20", "grep -rn 'a|b' src", "curl -s http://127.0.0.1:3900/"]) ok(c);
  });
  test("refused with the right code: curl https://example.com · git commit -m x · git -C /etc status · echo $HOME · bun run x & · cat <<EOF · node -e 1 · cp a /tmp/x · rm -r <read-only>/x · docker ps", () => {
    refused("curl https://example.com", "network"); refused("git commit -m x", "git_write"); refused("git -C /etc status", "outside"); refused("echo $HOME", "shell_feature");
    refused("bun run x &", "shell_feature"); refused("cat <<EOF", "shell_feature"); refused("node -e 1", "inline_code"); refused("cp a /tmp/x", "outside");
    refused(`rm -r ${spec}/x`, "read_only"); refused("docker ps", "not_allowed");
  });
});

// ---- Silver's review findings (TASK-118 rework), each both ways ----
describe("F1: ~user, ~+ and ~- are not the plain `~`", () => {
  test("`cat ~box/.bashrc`, `cat ~root/.ssh/id_rsa`, `cp a ~box/x`, `cat ~+/x`, `cat ~-/x` → shell_feature, the detail is the `~name`", () => {
    for (const [c, d] of [["cat ~box/.bashrc", "~box"], ["cat ~root/.ssh/id_rsa", "~root"], ["cp a ~box/x", "~box"], ["cat ~+/x", "~+"], ["cat ~-/x", "~-"], ["cat ~box", "~box"]] as const) {
      const r = judge(c);
      expect([c, r?.code, r?.detail]).toEqual([c, "shell_feature", d]);
    }
  });
  test("the same inside an option (`--file=~box/x`, `-f~box/x`) and as a redirect target / git -C dir", () => {
    for (const c of ["grep --file=~box/x y", "grep -f~box/x y", "ls > ~box/x", "cat < ~box/x", "git -C ~box status"]) refused(c, "shell_feature");
  });
  test("plain `~` and `~/…` are judged exactly as before (outside the folders → outside)", () => {
    refused("cat ~/x", "outside"); refused("ls ~", "outside"); refused("grep --file=~/x y", "outside");
  });
  test("a word that only CONTAINS a tilde is not a home reference: src/a~b.ts, a file named ~x in the middle of a path", () => {
    ok("cat src/a.ts"); ok("echo a~b"); ok("echo 'x ~box'"); // a quoted word that merely contains ~box after a space does not START with ~
  });
});

describe("F2: sed is not a command a worker may run", () => {
  test("sed → not_allowed, whatever its script (`1e cmd` runs a program, `w path` writes a file)", () => {
    for (const c of ["sed -n 1p src/a.ts", "sed -n '1e id' a.txt", "sed 's/x/y/w /tmp/out' a.txt", "sed -i s/a/b/ src/a.ts", "ls | sed s/a/b/"]) expect([c, judge(c)?.code, judge(c)?.detail]).toEqual([c, "not_allowed", "sed"]);
  });
  test("the file commands a worker still has are untouched: cat head tail grep wc … work on the same file", () => { ok("head -1 src/a.ts"); ok("grep -n ok src/a.ts"); });
});

describe("F3: an unquoted glob segment starting with `.` could expand to `..`", () => {
  test("`cat .?/.?/.?/etc/passwd`, `cp a .?/.?/x`, `ls .*`, `cat src/.[.]/x` → shell_feature, the detail is the segment (`ls .*` is refused too, which is acceptable: use `ls -A`)", () => {
    for (const [c, d] of [["cat .?/.?/.?/etc/passwd", ".?"], ["cp a .?/.?/x", ".?"], ["ls .*", ".*"], ["cat src/.[.]/x", ".[.]"], ["cat ./.?x", ".?x"], ["ls > .?/out", ".?"]] as const) {
      const r = judge(c);
      expect([c, r?.code, r?.detail]).toEqual([c, "shell_feature", d]);
    }
  });
  test("what stays fine: a QUOTED regex (`grep '.*' src`), a hidden file by name (`cat src/.env`), `*` and `?` in segments that do not start with a dot (`ls src/*.ts`, `cat s?c/a.ts`), `.` and `..` as themselves", () => {
    writeFileSync(join(root, "src", ".env"), "x");
    ok("grep -rn '.*' src"); ok('grep -rn ".?foo" src'); ok("cat src/.env"); ok("ls src/*.ts"); ok("cat s?c/a.ts"); ok("ls ."); ok("cat src/../src/a.ts");
  });
});

describe("fails closed", () => {
  test("an empty command, only redirects, only an operator → refused, never allowed", () => {
    for (const c of ["", "   ", "> out.txt", "&&", ";", "|"]) expect([c, judge(c)]).not.toEqual([c, null]);
  });
  test("judgeBash never throws on odd input", () => {
    for (const c of ["'", '"', "a'b\"c", "\u0000", "💥", "ls " + "x".repeat(10000), "\t\t"]) expect(() => judge(c)).not.toThrow();
  });
});
