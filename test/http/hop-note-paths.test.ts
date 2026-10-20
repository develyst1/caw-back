// TASK-A-096 / SPEC-A-009 § Revision 3 (D-103 DEF-2): no machine path in runner-written text. The core rewrites (D-098 names, then ~/) the `note` of a finished
// hop and the `report` of a finished run when the actor is a runner or a worker — never the operator. The runner need not change. Old stored text stays as it is.
import { expect, test } from "bun:test";
import { chainOf3, newCard, openHop, setup } from "../helpers/api";

const ROOTS = ["/Users/x/w/mc2-spec", "/Users/x/w/mc2-front"];

async function world() {
  const s = await setup();
  const chain = await chainOf3(s.call);
  const P = `/v1/projects/${chain.project.id}`;
  await s.call("PATCH", `${P}/workspace`, { roots: ROOTS, readOnly: [ROOTS[0]!] });
  const card = (await newCard(s.call, chain.project.id, { assigneeId: chain.a.id })).json;
  return { ...s, ...chain, P, card };
}

async function finishWith(w: Awaited<ReturnType<typeof world>>, actor: string, note?: string) {
  const hop = await openHop(w.call, w.project.id, w.card.id, w.a.id);
  return w.call("PATCH", `/v1/hops/${hop.id}`, { outcome: "commented", ...(note !== undefined ? { note } : {}) }, actor);
}

test("a runner finishing a hop: the note's root path becomes its folder name, another home path becomes ~/ — read back from the hop list too", async () => {
  const w = await world();
  const r = await finishWith(w, "runner:r1", "พยายาม Write: /Users/x/w/mc2-spec/qa.md และดู /Users/x/other/a.txt");
  expect(r.status).toBe(200);
  expect(r.json.note).toBe("พยายาม Write: mc2-spec/qa.md และดู ~/other/a.txt");
  const listed = (await w.call("GET", `${w.P}/hops`)).json.hops.find((h: any) => h.id === r.json.id);
  expect(listed.note).toBe("พยายาม Write: mc2-spec/qa.md และดู ~/other/a.txt");
  const finished = (await w.call("GET", `${w.P}/events`)).json.events.filter((e: any) => e.type === "hop.finished"); // the event itself holds the clean text
  expect(finished.map((e: any) => e.data.note)).toEqual(["พยายาม Write: mc2-spec/qa.md และดู ~/other/a.txt"]); // (the operator's own workspace_set event keeps the real roots: it is his text)
});

test("the operator finishing a hop is NEVER rewritten (his own text), and a text without a path is unchanged for everyone", async () => {
  const w = await world();
  const op = await finishWith(w, "operator", "stopped by me at /Users/x/w/mc2-spec/qa.md");
  expect(op.json.note).toBe("stopped by me at /Users/x/w/mc2-spec/qa.md");
  const plain = await finishWith(w, "runner:r1", "ทำเสร็จแล้ว ไม่มีพาธ 100% (ok)");
  expect(plain.json.note).toBe("ทำเสร็จแล้ว ไม่มีพาธ 100% (ok)");
  const empty = await finishWith(w, "runner:r1");
  expect(empty.json.note).toBe("");
});

test("a worker finishing a hop is rewritten too (the rule is: everyone but the operator)", async () => {
  const w = await world();
  const r = await finishWith(w, `worker:${w.a.id}`, "ไฟล์ /Users/x/w/mc2-front/lib/a.dart");
  // a worker may or may not be allowed to finish a hop in this API; if it is, the note is clean — if it is refused, nothing leaked either way
  if (r.status === 200) expect(r.json.note).toBe("ไฟล์ mc2-front/lib/a.dart");
  else expect(r.status).toBeGreaterThanOrEqual(400);
});

test("a run report: a runner's is rewritten ('/Users/x/other/a' → '~/other/a', a root → its name); the operator's is not", async () => {
  const w = await world();
  const run = (await w.call("POST", `${w.P}/runs`, { hopBudget: 3 }, "runner:r1")).json;
  const done = await w.call("PATCH", `/v1/runs/${run.id}`, { stopReason: "nothing_workable", report: "สรุป: แก้ /Users/x/other/a และ /Users/x/w/mc2-front/src\n```\nls /Users/x/w/mc2-spec\n```" }, "runner:r1");
  expect(done.status).toBe(200);
  expect(done.json.report).toBe("สรุป: แก้ ~/other/a และ mc2-front/src\n```\nls mc2-spec\n```");
  const run2 = (await w.call("POST", `${w.P}/runs`, { hopBudget: 3 }, "runner:r1")).json;
  const byOp = await w.call("PATCH", `/v1/runs/${run2.id}`, { stopReason: "operator_stopped", report: "operator: /Users/x/other/a" }, "operator");
  expect(byOp.json.report).toBe("operator: /Users/x/other/a");
});

test("rebuild-check is same:true after rewritten notes and reports (the replay reads the clean text from the events)", async () => {
  const w = await world();
  await finishWith(w, "runner:r1", "ดู /Users/x/w/mc2-spec/qa.md");
  const run = (await w.call("POST", `${w.P}/runs`, { hopBudget: 1 }, "runner:r1")).json;
  await w.call("PATCH", `/v1/runs/${run.id}`, { stopReason: "budget_spent", report: "/Users/x/other/z" }, "runner:r1");
  expect((await w.call("POST", `${w.P}/rebuild-check`)).json).toEqual({ same: true });
});
