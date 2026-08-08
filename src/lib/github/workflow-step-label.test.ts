import { describe, expect, it } from "vitest";

import { getSimpleStepLabel } from "@/lib/github/workflow-step-label";

describe("getSimpleStepLabel", () => {
  it("マッピング対象のステップ名には対応する簡易文言を返す", () => {
    expect(getSimpleStepLabel("Claude Code（実装・PR作成）")).toBe("AIが実装中");
    expect(getSimpleStepLabel("Run Claude Code Review")).toBe("AIがレビュー中");
    expect(getSimpleStepLabel("Claude Code（CI失敗修正）")).toBe("AIがCI失敗を修正中");
  });

  it("マッピング対象外のステップ名にはnullを返す", () => {
    expect(getSimpleStepLabel("Checkout")).toBeNull();
    expect(getSimpleStepLabel("Setup pnpm")).toBeNull();
  });

  it("ステップ名がnullの場合はnullを返す", () => {
    expect(getSimpleStepLabel(null)).toBeNull();
  });
});
