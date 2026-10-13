// The Blueprint client (SPEC-A-008 § What I read — the seam CAW calls), against a fake Blueprint serving recorded responses.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BlueprintUnreachable, createBlueprint } from "../../src/blueprint/client";
import { BP_NAME, BP_PROJECT, fakeBlueprint } from "../helpers/fake-blueprint";

const fix = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/blueprint/${name}.json`, import.meta.url), "utf8"));
const stops: (() => void)[] = [];
afterEach(() => { while (stops.length) stops.pop()!(); });
const fake = () => { const f = fakeBlueprint(); stops.push(f.stop); return f; };

test("getProject: the name; null when Blueprint says 404", async () => {
  const f = fake();
  const bp = createBlueprint(f.url);
  expect(await bp.getProject(BP_PROJECT)).toEqual({ name: BP_NAME });
  expect(await bp.getProject("00000000-0000-0000-0000-000000000099")).toBeNull();
});

test("getVersion: version + confirmedAt of a confirmed version; null when it does not exist", async () => {
  const bp = createBlueprint(fake().url);
  const v = fix("version-1-200");
  expect(await bp.getVersion(BP_PROJECT, 1)).toEqual({ version: 1, confirmedAt: v.confirmedAt });
  expect(await bp.getVersion(BP_PROJECT, 9)).toBeNull();
});

test("partContext: Blueprint's PartContext exactly as returned, untouched; null on 404", async () => {
  const bp = createBlueprint(fake().url);
  expect(await bp.partContext(BP_PROJECT, 1, "STEP-001")).toEqual(fix("context-v1-step-001"));
  expect(await bp.partContext(BP_PROJECT, 1, "NOPE-999")).toBeNull();
});

test("versionsAfter: the change feed as recorded", async () => {
  const bp = createBlueprint(fake().url);
  expect(await bp.versionsAfter(BP_PROJECT, 0)).toEqual(fix("feed-after-0"));
  expect(await bp.versionsAfter(BP_PROJECT, 1)).toEqual(fix("feed-after-1"));
});

test("a 5xx and a refused connection are blueprint_unreachable — never a null that reads as 'not found'", async () => {
  const f = fake();
  f.mode.down = true;
  const bp = createBlueprint(f.url);
  await expect(bp.getProject(BP_PROJECT)).rejects.toBeInstanceOf(BlueprintUnreachable);
  await expect(bp.versionsAfter(BP_PROJECT, 0)).rejects.toBeInstanceOf(BlueprintUnreachable);
  f.stop();
  await expect(createBlueprint(f.url).getVersion(BP_PROJECT, 1)).rejects.toBeInstanceOf(BlueprintUnreachable);
});

test("the default address is BLUEPRINT_URL, then http://127.0.0.1:4200 when it is empty", async () => {
  const { defaultBlueprintUrl } = await import("../../src/blueprint/client");
  expect(defaultBlueprintUrl({ BLUEPRINT_URL: "http://example.test:1" })).toBe("http://example.test:1");
  expect(defaultBlueprintUrl({ BLUEPRINT_URL: "" })).toBe("http://127.0.0.1:4200");
  expect(defaultBlueprintUrl({})).toBe("http://127.0.0.1:4200");
});
