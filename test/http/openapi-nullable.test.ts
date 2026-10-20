// TASK-A-095 (SA-B's ask B-111): the document is OpenAPI 3.1, and a registered schema the API may answer `null` for must SAY null —
// `anyOf: [{ $ref }, { type: "null" }]`, not a bare $ref (generated client types read a bare $ref as never-null). Docs only: the API already sends
// null. Read twice: from the live app (what the code emits now) and from the committed openapi.json (so a forgotten `bun run openapi:emit` fails here).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { setup } from "../helpers/api";

type Json = any;
const committed = (): Json => JSON.parse(readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"));
const live = async (): Promise<Json> => (await (await setup()).call("GET", "/v1/openapi.json")).json;

/** `anyOf` holds the $ref AND { type: "null" }, and nothing else; no bare $ref, no allOf wrapper */
function expectNullableRef(label: string, schema: Json, name: string, describedAs?: RegExp) {
  expect([label, schema.$ref, schema.allOf]).toEqual([label, undefined, undefined]);
  expect([label, schema.anyOf]).toEqual([label, expect.arrayContaining([{ $ref: `#/components/schemas/${name}` }, { type: "null" }])]);
  expect([label, schema.anyOf.length]).toEqual([label, 2]);
  if (describedAs) expect([label, schema.description]).toEqual([label, expect.stringMatching(describedAs)]); // the description survives
}

const bodyOf = (doc: Json, path: string, method: string): Json => doc.paths[path][method].requestBody.content["application/json"].schema;

for (const [source, get] of [["the live app", live], ["the committed openapi.json", async () => committed()]] as const) {
  test(`${source}: Project.codeMap, CardContext.codeMap and Worker.avatar are anyOf [$ref, null], with their descriptions`, async () => {
    const doc = await get();
    const s = doc.components.schemas;
    expectNullableRef("Project.codeMap", s.Project.properties.codeMap, "CodeMap", /null until/);
    expectNullableRef("CardContext.codeMap", s.CardContext.properties.codeMap, "CodeMap", /null until/);
    expectNullableRef("Worker.avatar", s.Worker.properties.avatar, "Avatar");
    expect(s.Project.required).toContain("codeMap"); // required AND nullable: the key is always there
    expect(s.CardContext.required).toContain("codeMap");
    expect(s.Worker.required).toContain("avatar");
  });

  test(`${source}: the worker request bodies' avatar (POST and PATCH) may be null too, and stays optional`, async () => {
    const doc = await get();
    for (const [path, method] of [["/v1/workers", "post"], ["/v1/workers/{id}", "patch"]] as const) {
      const body = bodyOf(doc, path, method);
      expectNullableRef(`${method} ${path} avatar`, body.properties.avatar, "Avatar");
      expect(body.required ?? []).not.toContain("avatar"); // omitted = not sent
    }
  });
}

test("no other registered schema is left as a bare $ref where the API can answer null: every `$ref` property that is nullable in the zod source is accounted for", async () => {
  const doc = committed();
  const s = doc.components.schemas;
  // the only nullable registered-schema properties in v1.16 are these three; a new one must be added to this list AND be anyOf [ref, null]
  const bare: string[] = [];
  for (const [name, schema] of Object.entries<Json>(s)) {
    for (const [prop, p] of Object.entries<Json>(schema.properties ?? {})) {
      if (p.$ref && /^(codeMap|avatar)$/.test(prop)) bare.push(`${name}.${prop}`);
    }
  }
  expect(bare).toEqual([]);
});
