import { describe, expect, it } from "vitest";

import {
  isLabelFilterPresetActive,
  LABEL_FILTER_PRESETS,
  requestPrFixCommentBody,
  withRollbackFailureNotice,
  withRollbackNotice,
} from "@/lib/github/approval-labels";

describe("LABEL_FILTER_PRESETS", () => {
  it("未着手プリセットは実装状況ラベル・00.check-userを除外条件に持つ", () => {
    const preset = LABEL_FILTER_PRESETS.find((item) => item.key === "not-started");
    expect(preset?.labels).toEqual([]);
    expect(preset?.excludeLabels).toEqual([
      "00.check-user",
      "01.wip",
      "03.d:marge",
      "05.develop",
      "07.m:marge",
      "09.main",
    ]);
  });
});

describe("isLabelFilterPresetActive", () => {
  it("excludeLabelsのみで定義されるプリセット（labelsが空）は常に非アクティブとして扱う", () => {
    const preset = LABEL_FILTER_PRESETS.find((item) => item.key === "not-started");
    expect(preset && isLabelFilterPresetActive([], preset)).toBe(false);
  });
});

describe("requestPrFixCommentBody", () => {
  it("修正依頼の入力がある場合はその内容を@claudeメンションに続けて返す", () => {
    expect(requestPrFixCommentBody("  ここを直してください  ")).toBe(
      "@claude ここを直してください",
    );
  });

  it("入力が空の場合は定型文を返す", () => {
    expect(requestPrFixCommentBody("")).toBe("@claude PRの内容を見直して修正してください。");
  });

  it("空白のみの入力も定型文を返す", () => {
    expect(requestPrFixCommentBody("   ")).toBe("@claude PRの内容を見直して修正してください。");
  });
});

describe("withRollbackNotice", () => {
  it("元のエラーメッセージにラベルロールバックの案内を追記する", () => {
    expect(withRollbackNotice("GitHub連携が必要です。再ログインしてください。")).toBe(
      "GitHub連携が必要です。再ログインしてください。 ラベルの変更は取り消しました。GitHubからログアウトし、再度ログインしてからもう一度お試しください。",
    );
  });
});

describe("withRollbackFailureNotice", () => {
  it("元のエラーメッセージにラベル復元失敗の案内を追記する", () => {
    expect(withRollbackFailureNotice("GitHub連携が必要です。再ログインしてください。")).toBe(
      "GitHub連携が必要です。再ログインしてください。 ラベルの復元にも失敗しました。手動でご確認ください。",
    );
  });
});
