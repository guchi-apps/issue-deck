import { describe, expect, it } from "vitest";

import {
  requestPrFixCommentBody,
  withRollbackFailureNotice,
  withRollbackNotice,
} from "@/lib/github/approval-labels";

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
