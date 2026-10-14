// probeHooks: before the first hop, every guard hook must PROVE it blocks (exit 2) on a payload it exists to stop. A hook that is
// present but inert — jq missing (they `exit 0` without it), a bad shebang, a crash — is the same as no hook (security review F2).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOKS, loadConfig } from "./config";
import { GuardError, PROBES, probeHooks } from "./guard";

describe("probeHooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "caw-guard-test-"));
  const script = (name: string, code: number) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\ncat >/dev/null\nexit ${code}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("each probe is a Bash/Edit payload that names what the hook blocks", () => {
    expect(Object.keys(PROBES).sort()).toEqual([...HOOKS].sort());
    expect(JSON.parse(PROBES["block-irreversible.sh"]).tool_input.command).toBe("git push origin HEAD");
  });

  test("passes when all three hooks exit 2 on their probe", async () => {
    const hooks = HOOKS.map((h) => script(h, 2));
    await expect(probeHooks(hooks)).resolves.toBeUndefined();
  });

  test("refuses, naming the hook, when one exits 0 (inert) — and says what to check", async () => {
    const hooks = HOOKS.map((h, i) => script(h, i === 1 ? 0 : 2));
    const err = await probeHooks(hooks).catch((e) => e);
    expect(err).toBeInstanceOf(GuardError);
    expect(err.message).toContain("block-irreversible.sh");
    expect(err.message).toContain("jq");
    expect(err.message).not.toContain("\n");
  });

  test("refuses when a hook crashes with another code (126/127/1), not only 0", async () => {
    for (const code of [1, 126, 127]) {
      const hooks = HOOKS.map((h, i) => script(h, i === 0 ? code : 2));
      await expect(probeHooks(hooks)).rejects.toThrow(String(code));
    }
  });
});

// Needs the real workspace (CAW_WORKSPACE_ROOT); without it this test is SKIPPED and bun says so — it is not a pass.
describe("the real guard hooks", () => {
  const WS = process.env.CAW_WORKSPACE_ROOT || "";
  test.skipIf(WS === "")("each real hook is executable and blocks its probe with exit 2 (jq and perl present on this machine)", async () => {
    const config = loadConfig({ CAW_WORKSPACE_ROOT: WS });
    await probeHooks(config.hooks);
  });
});
