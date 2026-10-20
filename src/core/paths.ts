// Machine paths out of worker-written text (SPEC-A-009 § R3a + Revision 1, REQ-015 AC-3, D-098). Pure: it knows roots and text, not actors or projects.
// Two rewrites, in order:
//   1. each project root → its D-098 name (the last path segment, or `parent/last` when two roots share a last segment), longest root first;
//   2. any other `/Users/<name>/` or `/home/<name>/` prefix → `~/` ("somewhere in your home": no longer a machine path, and AC-3's grep for `/Users/` finds nothing).
// Applied to worker-written reply, comment, ask_operator text and every string of the code map — never to the operator's own text (`rewriteForActor`).
// A path inside a fenced code block is rewritten too (AC-3 greps every reply).

const trimEnd = (p: string) => p.replace(/[\\/]+$/, "");
const segmentsOf = (p: string) => trimEnd(p).split(/[\\/]/).filter((x) => x !== "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** root → its D-098 name. Roots that still collide on `parent/last` get NO name (they fall to the home-prefix rule, never to one shared name). */
export function folderNames(roots: string[]): Map<string, string> {
  const list = [...new Set(roots.map(trimEnd).filter((r) => r !== ""))];
  const lastOf = (r: string) => segmentsOf(r).at(-1) ?? r;
  const sharing = new Map<string, number>();
  for (const r of list) sharing.set(lastOf(r), (sharing.get(lastOf(r)) ?? 0) + 1);
  const named = list.map((r) => {
    const segs = segmentsOf(r);
    const last = lastOf(r);
    return [r, sharing.get(last) === 1 || segs.length < 2 ? last : `${segs.at(-2)}/${last}`] as const;
  });
  const uses = new Map<string, number>();
  for (const [, n] of named) uses.set(n, (uses.get(n) ?? 0) + 1);
  return new Map(named.filter(([, n]) => uses.get(n) === 1));
}

// a root is a whole path: not the tail of a longer one (before) and not the start of a longer name (after: `mc2-front` vs `mc2-front-api`, `mc2-front.bak`)
const NOT_BEFORE = "(?<![\\w.~-])";
const HOME = /(?<![\w.~-])\/(?:Users|home)\/[^\s/\\"'`<>()[\]{},;|.]+(?:\.[^\s/\\"'`<>()[\]{},;|.]+)*(?:(\/)|(?![^\s/\\"'`<>()[\]{},;|.]|\/))/g;

export function rewritePaths(text: string, roots: string[]): string {
  const names = folderNames(roots);
  let out = text;
  for (const root of [...names.keys()].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`${NOT_BEFORE}${escapeRe(root)}(?![\\w-]|\\.\\w)`, "g"), () => names.get(root)!); // a function: `$` in a name is not a pattern
  }
  return out.replace(HOME, (_all, slash: string | undefined) => (slash ? "~/" : "~"));
}

/** A worker's text is rewritten; the operator's (and a runner's) never is. */
export const rewriteForActor = (actor: string, text: string, roots: string[]): string => (actor.startsWith("worker:") ? rewritePaths(text, roots) : text);
