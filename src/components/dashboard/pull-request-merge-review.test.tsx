// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PullRequestMergeReview } from "@/components/dashboard/pull-request-merge-review";
import type { PullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";

function verdict(overrides: Partial<PullRequestReviewVerdict> = {}): PullRequestReviewVerdict {
  return {
    reviewKind: "ok",
    reviewLabel: "問題なし（LGTM）",
    riskKind: "none",
    riskLabel: "該当なし",
    riskReasons: [],
    confirmLabel: "不要（自動マージの対象）",
    ...overrides,
  };
}

describe("PullRequestMergeReview", () => {
  afterEach(cleanup);

  it("判定・リスク・確認要否の3つを出す", () => {
    render(<PullRequestMergeReview verdict={verdict()} />);

    expect(screen.getByText("問題なし（LGTM）")).toBeTruthy();
    expect(screen.getByText("該当なし")).toBeTruthy();
    expect(screen.getByText("不要（自動マージの対象）")).toBeTruthy();
  });

  it("リスクに該当した理由もぶら下げる", () => {
    render(
      <PullRequestMergeReview
        verdict={verdict({
          reviewKind: "changes-requested",
          reviewLabel: "要修正",
          riskKind: "hit",
          riskLabel: "該当あり",
          riskReasons: ["認証・認可に関わる変更"],
          confirmLabel: "必要（自動マージはスキップされます）",
        })}
      />,
    );

    expect(screen.getByText("要修正")).toBeTruthy();
    expect(screen.getByText("認証・認可に関わる変更")).toBeTruthy();
  });

  it("記録が無いことも出す（「問題なし」と同じ見た目にしない）", () => {
    render(<PullRequestMergeReview verdict={null} />);

    expect(screen.getByText(/レビューの記録がありません/)).toBeTruthy();
  });

  it("PRのURLを渡したときだけレビューへの導線を出す", () => {
    const { rerender } = render(<PullRequestMergeReview verdict={verdict()} />);
    expect(screen.queryByRole("link", { name: /レビューを読む/ })).toBeNull();

    rerender(
      <PullRequestMergeReview
        verdict={verdict()}
        htmlUrl="https://github.com/guchi-apps/issue-deck/pull/2845"
      />,
    );
    expect(screen.getByRole("link", { name: /レビューを読む/ })).toBeTruthy();
  });
});
