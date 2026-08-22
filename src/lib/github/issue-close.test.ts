import { describe, expect, it } from "vitest";

import {
  CLOSE_REASON_LABELS,
  isCloseReasonLabelName,
  isLabelClearedOnClose,
} from "@/lib/github/issue-close";

describe("isLabelClearedOnClose", () => {
  it("`00.check-user`と理由ラベル（旧名を含む）・`11.local`を対象にする", () => {
    expect(isLabelClearedOnClose("00.check-user")).toBe(true);
    expect(isLabelClearedOnClose("01.check-plan")).toBe(true);
    expect(isLabelClearedOnClose("01.check-blocked")).toBe(true);
    expect(isLabelClearedOnClose("00.qa-answered")).toBe(true);
    expect(isLabelClearedOnClose("11.local")).toBe(true);
  });

  it("実装オプション・種別・クローズ理由は対象にしない", () => {
    // `21.plan-required`は再オープンしたときも計画提示が要るため残す
    expect(isLabelClearedOnClose("21.plan-required")).toBe(false);
    expect(isLabelClearedOnClose("22.merge-confirm-required")).toBe(false);
    expect(isLabelClearedOnClose("50.feature")).toBe(false);
    expect(isLabelClearedOnClose("71.manual-step")).toBe(false);
    expect(isLabelClearedOnClose("90.Close: duplicate")).toBe(false);
  });
});

describe("クローズ理由ラベル", () => {
  it("画面に出す4種はすべて`90.Close: `始まりで、APIの入力検証を通る", () => {
    expect(CLOSE_REASON_LABELS).toHaveLength(4);
    for (const reason of CLOSE_REASON_LABELS) {
      expect(reason.name.startsWith("90.Close: ")).toBe(true);
      expect(isCloseReasonLabelName(reason.name)).toBe(true);
    }
  });

  it("一覧に無いラベル名は受け付けない（任意のラベルを付けさせない）", () => {
    expect(isCloseReasonLabelName("90.Close: unknown")).toBe(false);
    expect(isCloseReasonLabelName("11.local")).toBe(false);
  });
});
