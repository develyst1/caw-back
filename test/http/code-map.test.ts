// TASK-A-094 / SPEC-A-009 § R2a + R3a + Revision 1 (REQ-015 AC-2, AC-3; D-097, D-098): the code map is the result of the "get to know the code" setup
// step — structured, written by the ENTRY worker from its running CHAT hop (PUT), confirmed by the operator. Machine paths in worker-written text are
// rewritten in the core (reply, comment, ask_operator, every string of the code map); the operator's own text never is.
import { eq } from "drizzle-orm";
import { expect, test } from "bun:test";
import { rebuild } from "../../src/core/rebuild";
import { events } from "../../src/db/schema";
import { chainOf3, chatHop, chatWorld, hopHeader, newCard, openHop, postChat, setup } from "../helpers/api";

const MAP = {
  folders: [{ name: "mc2-front", kind: "fe", note: "Flutter app" }, { name: "mc2-front-api", kind: "be" }, { name: "mc2-spec", kind: "other" }],
  stack: ["Flutter", "NestJS"],
  commands: { run: ["bun run dev"], test: ["bun test", "flutter test"] },
  rules: [],
  questions: [{ text: "ใช้ branch ไหน", proposedDefault: "main" }],
  notes: "บันทึกเพิ่มเติม",
};
const ROOTS = ["/Users/x/w/mc2-front", "/Users/x/w/mc2-front-api", "/Users/x/w/mc2-spec"];

async function world() {
  const s = await setup();
  const chain = await chatWorld(s.call); // a = the entry worker, b and c in the chain
  const P = `/v1/projects/${chain.project.id}`;
  const msg = (await postChat(s.call, chain.project.id)).json;
  const hop = await chatHop(s.call, chain.project.id, msg.id, chain.a.id);
  const as = `worker:${chain.a.id}`;
  const H = hopHeader(hop.id);
  const put = (body: unknown = MAP, actor: string | null = as, headers: Record<string, string> = H) => s.call("PUT", `${P}/code-map`, body, actor, headers);
  const confirm = (actor: string | null = "operator") => s.call("POST", `${P}/code-map/confirm`, undefined, actor);
  const getProject = async () => (await s.call("GET", P)).json;
  const setRoots = (roots: string[], readOnly?: string[]) => s.call("PATCH", `${P}/workspace`, { roots, ...(readOnly ? { readOnly } : {}) });
  const typed = async (type: string) => (await s.db.select().from(events).where(eq(events.type, type))).map((e) => [e.actor, e.projectId, e.data]);
  return { ...s, ...chain, P, msg, hop, as, H, put, confirm, getProject, setRoots, typed };
}

test("a fresh project has codeMap null; the entry worker's PUT from its running chat hop → 200 with the map, updatedBy, updatedAt and confirmedAt null; GET shows it", async () => {
  const w = await world();
  expect((await w.getProject()).codeMap).toBeNull();
  const r = await w.put();
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ...MAP, updatedAt: expect.any(String), updatedBy: w.a.id, confirmedAt: null });
  expect(Number.isNaN(Date.parse(r.json.updatedAt))).toBe(false);
  expect((await w.getProject()).codeMap).toEqual(r.json);
  const ev = await w.typed("project.code_map_saved");
  expect(ev).toHaveLength(1);
  expect(ev[0]![0]).toBe(w.as);
  expect(ev[0]![1]).toBe(w.project.id);
});

test("the operator confirms → confirmedAt is set (200, one event); confirming again changes nothing and writes nothing; a second PUT replaces the map and clears confirmedAt", async () => {
  const w = await w_with_map();
  const c = await w.confirm();
  expect(c.status).toBe(200);
  expect(c.json.confirmedAt).toBeString();
  expect((await w.getProject()).codeMap.confirmedAt).toBe(c.json.confirmedAt);
  const again = await w.confirm();
  expect([again.status, again.json.confirmedAt]).toEqual([200, c.json.confirmedAt]);
  expect(await w.typed("project.code_map_confirmed")).toHaveLength(1);
  const second = await w.put({ ...MAP, stack: ["Dart"], rules: ["ห้ามแก้ไฟล์ generated"] });
  expect(second.json).toMatchObject({ stack: ["Dart"], rules: ["ห้ามแก้ไฟล์ generated"], confirmedAt: null });
  expect((await w.getProject()).codeMap.confirmedAt).toBeNull();
  expect(await w.typed("project.code_map_saved")).toHaveLength(2);
});

test("refusals of the PUT: no hop header 400 hop_required · a CARD hop 403 not_your_message · a finished chat hop 403 · the operator 403 · a runner 403 runner_not_allowed — nothing written", async () => {
  const w = await world();
  const noHeader = await w.put(MAP, w.as, {});
  expect([noHeader.status, noHeader.json.error.code]).toEqual([400, "hop_required"]);
  const op = await w.put(MAP, "operator", {});
  expect([op.status, op.json.error.code]).toEqual([403, "not_your_message"]);
  const runner = await w.put(MAP, "runner:r1", {});
  expect([runner.status, runner.json.error.code]).toEqual([403, "runner_not_allowed"]);
  const stranger = await w.put(MAP, `worker:${w.b.id}`, w.H); // Ben presents Ann's hop
  expect([stranger.status, stranger.json.error.code]).toEqual([403, "not_your_message"]);
  await w.call("PATCH", `/v1/hops/${w.hop.id}`, { outcome: "replied" });
  const ended = await w.put();
  expect([ended.status, ended.json.error.code]).toEqual([403, "not_your_message"]);
  expect(await w.typed("project.code_map_saved")).toEqual([]);
  expect((await w.getProject()).codeMap).toBeNull();
});

test("a worker's CARD hop cannot write the code map (403 not_your_message)", async () => {
  const s = await setup();
  const chain = await chatWorld(s.call);
  const card = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id })).json;
  const hop = await openHop(s.call, chain.project.id, card.id, chain.a.id);
  const r = await s.call("PUT", `/v1/projects/${chain.project.id}/code-map`, MAP, `worker:${chain.a.id}`, hopHeader(hop.id));
  expect([r.status, r.json.error.code]).toEqual([403, "not_your_message"]);
});

test("only the project's ENTRY worker: after the entry moves to Ben, Ann's still-running chat hop is refused 403 not_entry_worker (and Ben, on a hop of his own, may write)", async () => {
  const w = await world();
  await w.call("PUT", `${w.P}/chain/entry`, { workerId: w.b.id });
  const r = await w.put();
  expect([r.status, r.json.error.code]).toEqual([403, "not_entry_worker"]);
  expect(await w.typed("project.code_map_saved")).toEqual([]);
  await w.call("PATCH", `/v1/hops/${w.hop.id}`, { outcome: "failed" });
  const msg2 = (await postChat(w.call, w.project.id, "ข้อความที่สอง")).json;
  const benHop = await chatHop(w.call, w.project.id, msg2.id, w.b.id);
  const ok = await w.put(MAP, `worker:${w.b.id}`, hopHeader(benHop.id));
  expect([ok.status, ok.json.updatedBy]).toEqual([200, w.b.id]);
});

test("confirm: none yet → 409 no_code_map · a worker → 403 operator_only · a runner → 403 runner_not_allowed · unknown project → 404", async () => {
  const w = await world();
  const none = await w.confirm();
  expect([none.status, none.json.error.code]).toEqual([409, "no_code_map"]);
  await w.put();
  const asWorker = await w.confirm(w.as);
  expect([asWorker.status, asWorker.json.error.code]).toEqual([403, "operator_only"]);
  expect((await w.confirm("runner:r1")).json.error.code).toBe("runner_not_allowed");
  expect((await w.call("POST", "/v1/projects/00000000-0000-4000-8000-000000000099/code-map/confirm", undefined, "operator")).status).toBe(404);
  expect((await w.call("POST", "/v1/projects/not-a-uuid/code-map/confirm", undefined, "operator")).status).toBe(404);
  expect((await w.getProject()).codeMap.confirmedAt).toBeNull();
});

test("limits (400 validation, nothing written): folders ≥ 1 and ≤ 50 · every string 1–500 · notes ≤ 2 000 · each list ≤ 50 · kind in fe|be|other · every key present — and rules may be []", async () => {
  const w = await world();
  const long = (n: number) => "ก".repeat(n);
  const bad: [string, unknown][] = [
    ["no folders", { ...MAP, folders: [] }], ["51 folders", { ...MAP, folders: Array.from({ length: 51 }, () => MAP.folders[0]) }],
    ["empty folder name", { ...MAP, folders: [{ name: "", kind: "fe" }] }], ["501-char name", { ...MAP, folders: [{ name: long(501), kind: "fe" }] }],
    ["bad kind", { ...MAP, folders: [{ name: "a", kind: "shared" }] }], ["empty note", { ...MAP, folders: [{ name: "a", kind: "fe", note: "" }] }],
    ["51 stack items", { ...MAP, stack: Array.from({ length: 51 }, (_, i) => `s${i}`) }], ["empty stack item", { ...MAP, stack: [""] }],
    ["501-char rule", { ...MAP, rules: [long(501)] }], ["51 rules", { ...MAP, rules: Array.from({ length: 51 }, (_, i) => `r${i}`) }],
    ["51 run commands", { ...MAP, commands: { run: Array.from({ length: 51 }, (_, i) => `c${i}`), test: [] } }], ["empty test command", { ...MAP, commands: { run: [], test: [""] } }],
    ["2 001-char notes", { ...MAP, notes: long(2001) }], ["empty notes", { ...MAP, notes: "" }],
    ["question without default", { ...MAP, questions: [{ text: "x" }] }], ["51 questions", { ...MAP, questions: Array.from({ length: 51 }, () => ({ text: "q", proposedDefault: "d" })) }],
    ["missing folders", { stack: [], commands: { run: [], test: [] }, rules: [], questions: [] }], ["missing commands", { ...MAP, commands: undefined }],
    ["commands.run a string", { ...MAP, commands: { run: "x", test: [] } }], ["a string", "text"], ["an array", []],
  ];
  for (const [label, body] of bad) {
    const r = await w.put(body);
    expect([label, r.status, r.json.error?.code]).toEqual([label, 400, "validation"]);
  }
  expect(await w.typed("project.code_map_saved")).toEqual([]);
  const edges = await w.put({ ...MAP, rules: [], stack: [], commands: { run: [], test: [] }, questions: [], notes: undefined, folders: [{ name: "ก".repeat(500), kind: "other" }] });
  expect(edges.status).toBe(200); // 500 chars, rules [] and the other lists empty are allowed
  expect(edges.json).not.toHaveProperty("notes");
  expect((await w.put({ ...MAP, notes: "ก".repeat(2000) })).status).toBe(200);
});

test("the client cannot set the stamps: updatedAt, updatedBy and confirmedAt in the body are ignored", async () => {
  const w = await world();
  const r = await w.put({ ...MAP, updatedAt: "2001-01-01T00:00:00.000Z", updatedBy: "evil", confirmedAt: "2001-01-01T00:00:00.000Z" });
  expect(r.status).toBe(200);
  expect([r.json.updatedBy, r.json.confirmedAt, r.json.updatedAt === "2001-01-01T00:00:00.000Z"]).toEqual([w.a.id, null, false]);
});

test("every later hop knows the folders: the card context and the chat context carry codeMap (null before it exists)", async () => {
  const w = await world();
  const card = (await newCard(w.call, w.project.id, { assigneeId: w.a.id })).json;
  expect((await w.call("GET", `/v1/cards/${card.id}/context`)).json.codeMap).toBeNull();
  expect((await w.call("GET", `/v1/chat/${w.msg.id}/context`)).json.project.codeMap).toBeNull();
  const saved = (await w.put()).json;
  expect((await w.call("GET", `/v1/cards/${card.id}/context`)).json.codeMap).toEqual(saved);
  expect((await w.call("GET", `/v1/chat/${w.msg.id}/context`)).json.project.codeMap).toEqual(saved);
});

test("rebuild-check is same:true after save · confirm · save again · rewrite, and the replay gives the same map", async () => {
  const w = await world();
  await w.setRoots(ROOTS);
  await w.put({ ...MAP, notes: "ดู /Users/x/w/mc2-front/src และ /Users/x/other/b.md" });
  await w.confirm();
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
  const second = (await w.put({ ...MAP, stack: ["Dart"] })).json;
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
  expect((await rebuild(w.db, w.project.id)).project!.codeMap).toEqual(second);
});

// ---- the path rewrite, seen through the API ----

test("code map: every string is rewritten before it is stored — folder names and notes, stack, commands, rules, questions, notes — roots → their names, other home paths → ~/", async () => {
  const w = await world();
  await w.setRoots(ROOTS);
  const P1 = "/Users/x/w/mc2-front/lib", P2 = "/Users/x/w/mc2-front-api/src", OUT = "/Users/x/other/b.md";
  const r = await w.put({
    folders: [{ name: P1, kind: "fe", note: `ดู ${P2}` }, { name: "mc2-spec", kind: "other", note: OUT }],
    stack: [`Flutter ใน ${P1}`], commands: { run: [`cd ${P2} && bun run dev`], test: [`cd ${P1} && flutter test`] },
    rules: [`อย่าแก้ ${OUT}`], questions: [{ text: `ไฟล์ ${OUT} ใช้ทำอะไร`, proposedDefault: `ทิ้ง ${P1}` }], notes: `สรุป: ${P1} กับ ${P2}`,
  });
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({
    folders: [{ name: "mc2-front/lib", kind: "fe", note: "ดู mc2-front-api/src" }, { name: "mc2-spec", kind: "other", note: "~/other/b.md" }],
    stack: ["Flutter ใน mc2-front/lib"], commands: { run: ["cd mc2-front-api/src && bun run dev"], test: ["cd mc2-front/lib && flutter test"] },
    rules: ["อย่าแก้ ~/other/b.md"], questions: [{ text: "ไฟล์ ~/other/b.md ใช้ทำอะไร", proposedDefault: "ทิ้ง mc2-front/lib" }], notes: "สรุป: mc2-front/lib กับ mc2-front-api/src",
  });
  expect(JSON.stringify(r.json)).not.toContain("/Users/");
});

test("reply (a worker's chat hop): text and the questions' strings are rewritten, a fenced block too; the operator's own chat text with /Users/… is stored unchanged", async () => {
  const w = await world();
  await w.setRoots(ROOTS);
  const operator = await w.call("POST", `${w.P}/chat`, { text: "ดูไฟล์ /Users/x/w/mc2-front/a.ts ด้วย" });
  expect(operator.json.text).toBe("ดูไฟล์ /Users/x/w/mc2-front/a.ts ด้วย"); // never rewritten
  const reply = await w.call("POST", `/v1/chat/${w.msg.id}/reply`, {
    text: "อ่านแล้ว\n```\ncd /Users/x/w/mc2-front-api\n```\nและ /Users/x/other/b.md",
    questions: [{ text: "ใช้ /Users/x/w/mc2-front หรือไม่", proposedDefault: "ใช้ /Users/x/w/mc2-front", cases: ["ใช้ /Users/x/other", "ไม่ใช้"] }],
  }, w.as, w.H);
  expect(reply.status).toBe(201);
  expect(reply.json.text).toBe("อ่านแล้ว\n```\ncd mc2-front-api\n```\nและ ~/other/b.md");
  expect(reply.json.questions).toEqual([{ text: "ใช้ mc2-front หรือไม่", proposedDefault: "ใช้ mc2-front", cases: ["ใช้ ~/other", "ไม่ใช้"] }]);
  const stored = (await w.call("GET", `${w.P}/chat`)).json.messages.map((m: any) => m.text);
  expect(stored.some((t: string) => t.includes("/Users/x/w/mc2-front/a.ts"))).toBe(true); // the operator's line, still literal
  expect(stored.filter((t: string) => t !== "ดูไฟล์ /Users/x/w/mc2-front/a.ts ด้วย").some((t: string) => t.includes("/Users/"))).toBe(false);
});

test("comment and ask_operator (a worker on a card hop): text, proposedDefault and cases are rewritten; the operator's own comment is unchanged; hand_off text is NOT rewritten (not asked)", async () => {
  const s = await setup();
  const { project, a, b } = await chainOf3(s.call);
  await s.call("PATCH", `/v1/projects/${project.id}/workspace`, { roots: ROOTS });
  await s.call("POST", `/v1/projects/${project.id}/chain/edges`, { from: a.id, to: b.id });
  const card = (await newCard(s.call, project.id, { assigneeId: a.id })).json;
  const hop = await openHop(s.call, project.id, card.id, a.id);
  const as = `worker:${a.id}`, H = hopHeader(hop.id);
  const comment = await s.call("POST", `/v1/cards/${card.id}/comments`, { text: "แก้ใน /Users/x/w/mc2-front/src/a.ts แล้ว ดู /Users/x/other/b.md" }, as, H);
  expect(comment.json.text).toBe("แก้ใน mc2-front/src/a.ts แล้ว ดู ~/other/b.md");
  const op = await s.call("POST", `/v1/cards/${card.id}/comments`, { text: "operator: /Users/x/w/mc2-front/src/a.ts" }, "operator");
  expect(op.json.text).toBe("operator: /Users/x/w/mc2-front/src/a.ts");
  const q = await s.call("POST", `/v1/cards/${card.id}/question`, { text: "ใช้ /Users/x/w/mc2-front-api ไหม", proposedDefault: "ใช้ /Users/x/w/mc2-front-api", cases: ["/Users/x/other", "ไม่"] }, as, H);
  expect(q.status).toBe(201);
  expect(q.json.question).toEqual({ text: "ใช้ mc2-front-api ไหม", proposedDefault: "ใช้ mc2-front-api", cases: ["~/other", "ไม่"] });
  const handed = await s.call("POST", `/v1/cards/${card.id}/handoff`, { toWorkerId: b.id, text: "ดู /Users/x/w/mc2-front/a.ts", reason: "ต้องมีหน้าจอ" }, as, H); // BE → FE-only: a reason (REQ-125)
  expect(handed.status).toBe(200);
  const notes = (await s.call("GET", `/v1/cards/${card.id}/context`)).json.notes.map((n: any) => n.text);
  expect(notes).toContain("ดู /Users/x/w/mc2-front/a.ts\n\nต้องมีหน้าจอ"); // hand_off keeps its text as sent (v1.13 left it alone too); the reason follows after a blank line
});

test("D-098 through the API: two roots sharing a last segment are shown as parent/last; the read-only roots count like the writable ones (Revision 2)", async () => {
  const w = await world();
  const roots = ["/Users/x/a/usb-oda", "/Users/x/b/usb-oda", "/Users/x/w/mc2-spec"];
  expect((await w.setRoots(roots, ["/Users/x/w/mc2-spec"])).status).toBe(200);
  const reply = await w.call("POST", `/v1/chat/${w.msg.id}/reply`, { text: "/Users/x/a/usb-oda/lib กับ /Users/x/b/usb-oda/lib กับ /Users/x/w/mc2-spec/docs" }, w.as, w.H);
  expect(reply.json.text).toBe("a/usb-oda/lib กับ b/usb-oda/lib กับ mc2-spec/docs");
});

async function w_with_map() {
  const w = await world();
  await w.put();
  return w;
}

test("the OpenAPI document says what the card context carries: CardContext has codeMap (nullable CodeMap), like the chat context's project (B and C read the contract there)", async () => {
  const w = await world();
  const doc = (await w.call("GET", "/v1/openapi.json")).json;
  const ctx = doc.components.schemas.CardContext;
  expect(Object.keys(ctx.properties)).toContain("codeMap");
  expect(JSON.stringify(ctx.properties.codeMap)).toContain("CodeMap"); // a reference to the named CodeMap schema, nullable
  expect(ctx.required).toContain("codeMap");
  expect(Object.keys(doc.components.schemas.Project.properties)).toContain("codeMap"); // and the Project (so the chat context's project) already does
});
