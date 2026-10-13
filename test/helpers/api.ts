// A CAW app on PGlite with a fake Blueprint (recorded responses), and a `call` that sends X-CAW-Actor.
import { afterEach } from "bun:test";
import { createApp } from "../../src/app";
import { createBlueprint } from "../../src/blueprint/client";
import { createFollower } from "../../src/follow/pull";
import { BP_PROJECT, fakeBlueprint } from "./fake-blueprint";
import { testDb } from "./db";

const stops: (() => void)[] = [];
afterEach(() => { while (stops.length) stops.pop()!(); });

export type Call = (method: string, path: string, body?: unknown, actor?: string | null) => Promise<{ status: number; json: any }>;

export async function setup() {
  const db = await testDb();
  const fake = fakeBlueprint();
  stops.push(fake.stop);
  const blueprint = createBlueprint(fake.url);
  const logs: string[] = [];
  const follow = createFollower(db, blueprint, (line) => logs.push(line));
  const app = createApp(db, { blueprint, follow });
  const call: Call = async (method, path, body, actor = "operator") => {
    const res = await app.request(path, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(actor === null ? {} : { "x-caw-actor": actor }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  return { db, fake, app, call, follow, logs };
}

export const createProject = (call: Call, over: object = {}) =>
  call("POST", "/v1/projects", { blueprintProjectId: BP_PROJECT, version: 1, ...over });

export async function mkWorker(call: Call, name: string, role = "BE", skills: string[] = [name], extra: object = {}) {
  const r = await call("POST", "/v1/workers", { name, role, skills, ...extra });
  if (r.status !== 201) throw new Error(`worker ${name}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json as { id: string; name: string; role: string; skills: string[]; model: string; effort: string; combinedFrom: string[] | null };
}

/** a project, workers a / b / c (BE, FE, QA) all in its chain; `ids` = their ids */
export async function chainOf3(call: Call) {
  const project = (await createProject(call)).json;
  const [a, b, c] = [await mkWorker(call, "Ann", "BE"), await mkWorker(call, "Ben", "FE"), await mkWorker(call, "Cat", "QA")];
  for (const w of [a, b, c]) await call("POST", `/v1/projects/${project.id}/chain/members`, { workerId: w.id });
  return { project, a, b, c };
}

export const newCard = (call: Call, projectId: string, over: object = {}) =>
  call("POST", `/v1/projects/${projectId}/cards`, { title: "ทำหน้าอนุมัติ", todo: "ทำตาม STEP-004", anchor: { key: "STEP-004", version: 1 }, ...over });
