import { describe, expect, test } from "bun:test";
import { redact } from "./redact";

describe("redact — secrets must not reach the stored note or the log (security review F8)", () => {
  test("user:password in a URL", () => {
    expect(redact("git push https://bob:s3cret@github.com/x/y.git HEAD")).toBe("git push https://***@github.com/x/y.git HEAD");
  });
  test("token=… key=… secret=… password=… forms, in a query or an env assignment", () => {
    expect(redact("curl 'https://h/x?token=abc123&page=2'")).toBe("curl 'https://h/x?token=***&page=2'");
    expect(redact("API_KEY=sk-live-999 run")).toBe("API_KEY=*** run");
    expect(redact("password=hunter2")).toBe("password=***");
    expect(redact("--secret=zzz")).toBe("--secret=***");
  });
  test("a Bearer header", () => {
    expect(redact("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer ***");
  });
  test("text with nothing secret is returned unchanged", () => {
    const s = "git push origin HEAD 2>&1 — ไม่อนุญาต";
    expect(redact(s)).toBe(s);
  });
  test("a word that merely contains 'key' is not touched", () => {
    expect(redact("monkey=banana keyboard=us")).toBe("monkey=banana keyboard=us");
  });
});
