import { afterEach, describe, expect, it } from "vitest";

import { authorizeProgressReport } from "@/lib/progress-report-auth";

const ORIGINAL_SECRET = process.env.PROGRESS_REPORT_SECRET;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.PROGRESS_REPORT_SECRET;
  } else {
    process.env.PROGRESS_REPORT_SECRET = ORIGINAL_SECRET;
  }
});

describe("authorizeProgressReport", () => {
  it("シークレット未設定なら値の一致にかかわらずnot_configuredを返す", () => {
    delete process.env.PROGRESS_REPORT_SECRET;
    expect(authorizeProgressReport("Bearer anything")).toBe("not_configured");
    expect(authorizeProgressReport(null)).toBe("not_configured");
  });

  it("Bearerトークンが一致すればokを返す", () => {
    process.env.PROGRESS_REPORT_SECRET = "s3cret-value";
    expect(authorizeProgressReport("Bearer s3cret-value")).toBe("ok");
  });

  it("値が違う・スキームが違う・ヘッダーが無い場合はunauthorizedを返す", () => {
    process.env.PROGRESS_REPORT_SECRET = "s3cret-value";
    expect(authorizeProgressReport("Bearer wrong")).toBe("unauthorized");
    // 長さが同じでも中身が違えば通さない（timingSafeEqualの経路を通る）
    expect(authorizeProgressReport("Bearer s3cret-valuf")).toBe("unauthorized");
    expect(authorizeProgressReport("token s3cret-value")).toBe("unauthorized");
    expect(authorizeProgressReport("s3cret-value")).toBe("unauthorized");
    expect(authorizeProgressReport(null)).toBe("unauthorized");
  });
});
