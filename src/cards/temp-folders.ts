// A temp folder in the work folder (REQ-126, SPEC-125 D7): a browser profile, a cache, a scratch folder that a worker left inside a project folder (TEST-122 F-5: a 58 MB Chrome profile). The check only LOOKS —
// it reads the folder's top level and asks git whether a name is tracked; CAW never deletes anything. Used when a worker moves a card to review or done.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** names that are a temp folder when git does not track them (a product may ship a tracked `tmp/`) */
const NAMES = new Set([".cache", ".tmp", "tmp", ".playwright", "playwright-profile", "chrome-profile", "user-data-dir"]);

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/** git tracks something under `name` in `root`: `git -C <root> ls-files -- <name>` prints a line. A root that is not a git work tree (or no git) counts as untracked. Read-only: no lock is taken. */
function tracked(root: string, name: string): boolean {
  try {
    const r = Bun.spawnSync(["git", "-C", root, "ls-files", "--", name], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return r.exitCode === 0 && new TextDecoder().decode(r.stdout).trim() !== "";
  } catch { return false; }
}

/** The first temp folder in the project's WRITABLE roots, or null. For each writable root only the top-level directories are looked at (no recursion), sorted. One is a temp folder when
 *  (i) it holds a Chromium/Chrome profile — a file `Local State`, or `Default/Preferences` — or (ii) its name is in the fixed list and git does not track it. Returns its name.
 *  `isTracked` is git's answer, injectable so a test can say "tracked" without making a repository. */
export function tempFolderIn(roots: string[], readOnly: string[], isTracked: (root: string, name: string) => boolean = tracked): string | null {
  for (const root of roots.filter((r) => !readOnly.includes(r))) {
    let names: string[];
    try { names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { continue; } // a root that is not there has nothing in it
    for (const name of names) {
      const dir = join(root, name);
      if (isFile(join(dir, "Local State")) || isFile(join(dir, "Default", "Preferences"))) return name;
      if (NAMES.has(name) && existsSync(dir) && !isTracked(root, name)) return name;
    }
  }
  return null;
}
