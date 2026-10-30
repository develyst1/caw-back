// REQ-118 (SPEC-117 D2.1, TASK-149): GET /v1/projects/{projectId}/requirements — every requirement of Blueprint's CURRENT spec, with its text, for the entry chat hop's system prompt.
// The fake Blueprint's `/spec` parts are SYNTHETIC (SPEC-106 v2 route 1, until recorded): a test sets `fake.mode.snapshot`.
import { expect, test } from "bun:test";
import { chainOf3, setup } from "../helpers/api";

const part = (key: string, kind: string, title: string, text?: string) => ({ key, kind, title, body: text === undefined ? {} : { text }, origin: { date: "2026-10-30", stamp: "operator" } });

test("3 requirements + 1 decision in the spec → only the 3, numeric-aware key order (REQ-002 before REQ-010), `text` from body.text verbatim", async () => {
  const s = await setup();
  const { project } = await chainOf3(s.call);
  s.fake.mode.snapshot = {
    parts: [part("REQ-010", "requirement", "สิบ", "ข้อสิบ\nบรรทัดสอง"), part("DEC-001", "decision", "กฎ"), part("REQ-002", "requirement", "สอง", "ข้อสอง"), part("REQ-001", "requirement", "หนึ่ง", "ข้อหนึ่ง")],
    links: [],
  };
  s.fake.mode.spec.revision = 4;
  const r = await s.call("GET", `/v1/projects/${project.id}/requirements`);
  expect([r.status, r.json]).toEqual([200, { revision: 4, requirements: [
    { key: "REQ-001", title: "หนึ่ง", text: "ข้อหนึ่ง" }, { key: "REQ-002", title: "สอง", text: "ข้อสอง" }, { key: "REQ-010", title: "สิบ", text: "ข้อสิบ\nบรรทัดสอง" },
  ] }]);
  expect(Object.keys(r.json)).toEqual(["revision", "requirements"]);
});

test("no requirement in the spec → an empty list (and the revision)", async () => {
  const s = await setup();
  const { project } = await chainOf3(s.call);
  s.fake.mode.snapshot = { parts: [part("DEC-001", "decision", "กฎ")], links: [] };
  const r = await s.call("GET", `/v1/projects/${project.id}/requirements`);
  expect([r.status, r.json]).toEqual([200, { revision: 1, requirements: [] }]);
});

test("Blueprint down → 502 blueprint_unreachable; an unknown project → 404", async () => {
  const s = await setup();
  const { project } = await chainOf3(s.call);
  s.fake.mode.down = true;
  const down = await s.call("GET", `/v1/projects/${project.id}/requirements`);
  expect([down.status, down.json.error.code]).toEqual([502, "blueprint_unreachable"]);
  s.fake.mode.down = false;
  const gone = await s.call("GET", "/v1/projects/00000000-0000-4000-8000-000000000099/requirements");
  expect([gone.status, gone.json.error.code]).toEqual([404, "not_found"]);
});
