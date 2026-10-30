// REQ-126 (SPEC-125 D7, TASK-168): a worker's move of a card to review or done is refused while a temp folder (a browser profile, an untracked cache/tmp folder) sits in the project's writable folders.
// CAW only looks — it never deletes. The operator is never refused. The folders are real temp folders on disk; none is a git repository, so "untracked" is what git says for a root that is not a work tree.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempFolderIn } from "../../src/cards/temp-folders";
import { chainOf3, hopHeader, newCard, openHop, setup } from "../helpers/api";

const made: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "caw-tempf-")); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const put = (root: string, ...paths: string[]) => { for (const p of paths) { const full = join(root, p); if (p.endsWith("/")) mkdirSync(full, { recursive: true }); else { mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, "x"); } } };
const NOTE = { done: "ทำแล้ว", howToTry: "เปิดดู" };

async function world(roots: string[], readOnly: string[] = []) {
  const s = await setup();
  const { project, a } = await chainOf3(s.call);
  const r = await s.call("PATCH", `/v1/projects/${project.id}/workspace`, { roots, readOnly });
  if (r.status !== 200) throw new Error(JSON.stringify(r.json));
  const card = (await newCard(s.call, project.id, { assigneeId: a.id })).json;
  const H = hopHeader((await openHop(s.call, project.id, card.id, a.id)).id);
  const as = `worker:${a.id}`;
  const move = (status: string, body: object = {}, actor = as) => s.call("PATCH", `/v1/cards/${card.id}/status`, { status, ...body }, actor, actor === as ? H : {});
  return { ...s, move, card };
}

test("a Chromium profile (a file `Local State`) in a writable root → review refused, 409 temp_folder_in_work naming it; nothing deleted, the card unchanged", async () => {
  const root = tmp();
  put(root, "chrome-data/Local State", "src/a.ts");
  const w = await world([root]);
  const before = (await w.call("GET", `/v1/cards/${w.card.id}`)).json.status;
  const r = await w.move("review", NOTE);
  expect([r.status, r.json.error.code, r.json.error.details]).toEqual([409, "temp_folder_in_work", { folder: "chrome-data" }]);
  expect(r.json.error.message).toBe("ยังส่งไม่ได้ — มีโฟลเดอร์ชั่วคราว chrome-data ในโฟลเดอร์งาน ให้ย้ายไปไว้ใน $TMPDIR หรือลบออกก่อน");
  expect(existsSync(join(root, "chrome-data", "Local State"))).toBe(true); // CAW never deletes
  expect((await w.call("GET", `/v1/cards/${w.card.id}`)).json.status).toBe(before);
});

test("a profile with `Default/Preferences` is refused too; so is an untracked `.cache`", async () => {
  const a = tmp(); put(a, "profile/Default/Preferences");
  expect((await (await world([a])).move("review", NOTE)).json.error.details).toEqual({ folder: "profile" });
  const b = tmp(); put(b, ".cache/");
  expect((await (await world([b])).move("review", NOTE)).json.error.details).toEqual({ folder: ".cache" });
});

test("`done` is checked like `review`; `todo` and `doing` are never checked", async () => {
  const root = tmp(); put(root, ".cache/");
  const w = await world([root]);
  expect((await w.move("done")).json.error.code).toBe("temp_folder_in_work");
  expect((await w.move("doing")).status).toBe(200);
  expect((await w.move("todo")).status).toBe(200);
});

test("a normal folder (`src/`), or a folder that is not on the list, is allowed — review goes through", async () => {
  const root = tmp(); put(root, "src/a.ts", "docs/readme.md", "node_modules/x/y.js");
  const w = await world([root]);
  const r = await w.move("review", NOTE);
  expect([r.status, r.json.status]).toEqual([200, "review"]);
});

test("a READ-ONLY root's `.cache` is not the worker's to clean: allowed", async () => {
  const rw = tmp(), ro = tmp();
  put(rw, "src/a.ts"); put(ro, ".cache/", "chrome/Local State");
  const w = await world([rw, ro], [ro]);
  expect((await w.move("review", NOTE)).status).toBe(200);
});

test("the operator is never refused", async () => {
  const root = tmp(); put(root, ".cache/");
  const w = await world([root]);
  const r = await w.move("review", {}, "operator");
  expect([r.status, r.json.status]).toEqual([200, "review"]);
});

test("the REQ-125 note check comes first: no note and a temp folder → review_note_missing", async () => {
  const root = tmp(); put(root, ".cache/");
  const w = await world([root]);
  expect((await w.move("review")).json.error.code).toBe("review_note_missing");
});

test("tempFolderIn: top-level DIRECTORIES only (no recursion, a file named `.cache` is nothing), the first sorted name, a missing root is skipped", () => {
  const root = tmp(); put(root, "src/.cache/", "zz/Local State", ".tmp/", "aa/");
  writeFileSync(join(root, ".cache"), "not a folder");
  expect(tempFolderIn([root], [])).toBe(".tmp"); // .tmp < zz; `src/.cache` is one level down; the file `.cache` is not a directory
  expect(tempFolderIn([join(root, "does-not-exist"), root], [])).toBe(".tmp");
  const clean = tmp(); put(clean, "src/.cache/", "a.txt");
  expect(tempFolderIn([clean], [])).toBeNull();
});

test("tempFolderIn: a tracked `tmp/` is the product's own (git says tracked) → allowed; a profile marker is a temp folder even when tracked", () => {
  const root = tmp(); put(root, "tmp/");
  expect(tempFolderIn([root], [], () => true)).toBeNull();
  expect(tempFolderIn([root], [], () => false)).toBe("tmp");
  put(root, "pw-profile/Local State");
  expect(tempFolderIn([root], [], () => true)).toBe("pw-profile"); // (i) does not ask git
  expect(tempFolderIn([root], [root], () => false)).toBeNull(); // a read-only root is not looked at
});

test("tempFolderIn: every name of the fixed list counts when untracked", () => {
  for (const name of [".cache", ".tmp", "tmp", ".playwright", "playwright-profile", "chrome-profile", "user-data-dir"]) {
    const root = tmp(); put(root, `${name}/`);
    expect([name, tempFolderIn([root], [])]).toEqual([name, name]);
  }
});
