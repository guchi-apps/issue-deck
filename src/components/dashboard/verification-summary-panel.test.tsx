// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VerificationSummaryPanel } from "@/components/dashboard/verification-summary-panel";
import { parseReleaseVerification } from "@/lib/github/release-verification";

const RELEASE_BODY = `developの内容をv4.49.0としてmainへリリースします。

## 対象issue
- #2441 レビューのゲートを直す
- #2438 更新履歴の文言を短くする

## コードレビューの検証結果

| Issue | PR | 自動レビュー | 機械的リスク判定 |
| --- | --- | --- | --- |
| #2441 | #2446 | ✅ 問題なし | 該当なし |
| #2443 | #2445 | ⚠️ 要確認 | ⚠️ 該当あり |
| #2438 | #2450 | ❌ 要修正 | 該当なし |
| #2432 | — | ? 記録なし | ? 記録なし |
`;

function verification() {
  const parsed = parseReleaseVerification(RELEASE_BODY);
  if (!parsed) throw new Error("テスト用の検証結果を読めませんでした");
  return parsed;
}

afterEach(cleanup);

describe("VerificationSummaryPanel（#2838）", () => {
  it("onCreateFixIssueを渡さない場合、要修正・要確認の行にもボタンを出さない", () => {
    render(
      <VerificationSummaryPanel verification={verification()} repositoryFullName="guchi-apps/aide" />,
    );

    expect(screen.queryByRole("button", { name: "修正をIssueにする" })).toBeNull();
  });

  it("要修正・要確認の行にだけボタンを出し、問題なし・記録なしの行には出さない", () => {
    render(
      <VerificationSummaryPanel
        verification={verification()}
        repositoryFullName="guchi-apps/aide"
        onCreateFixIssue={vi.fn()}
      />,
    );

    // #2443（要確認）・#2438（要修正）の2件だけ
    expect(screen.getAllByRole("button", { name: "修正をIssueにする" })).toHaveLength(2);
  });

  it("押すと対象の行をそのまま渡す", () => {
    const onCreateFixIssue = vi.fn();
    render(
      <VerificationSummaryPanel
        verification={verification()}
        repositoryFullName="guchi-apps/aide"
        onCreateFixIssue={onCreateFixIssue}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "修正をIssueにする" })[0]);
    expect(onCreateFixIssue).toHaveBeenCalledTimes(1);
    expect(onCreateFixIssue.mock.calls[0][0].issueNumber).toBe(2443);
  });
});
