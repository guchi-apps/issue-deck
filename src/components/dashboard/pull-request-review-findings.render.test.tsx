// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestReviewFindings } from "@/components/dashboard/pull-request-review-findings";
import type { PullRequestReviewCommentContent } from "@/lib/github/pull-request-review-comment";

function review(
  overrides: Partial<PullRequestReviewCommentContent> = {},
): PullRequestReviewCommentContent {
  return {
    verdictKind: "changes-requested",
    verdictLabel: "要修正",
    body: "## 気になった点\n\n- `progress-drag.ts:88` を直してください。",
    createdAt: new Date().toISOString(),
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/2851#issuecomment-1",
    reviewedSha: "0123456789abcdef0123456789abcdef01234567",
    isStale: false,
    ...overrides,
  };
}

describe("PullRequestReviewFindings", () => {
  afterEach(() => {
    cleanup();
  });

  it("判定とレビュー本文を、開いた状態で出す", () => {
    render(<PullRequestReviewFindings review={review()} pullRequestNumber={2851} />);

    expect(screen.getByText("要修正")).toBeTruthy();
    expect(screen.getByText(/PR #2851 のレビューコメントから/)).toBeTruthy();
    expect(screen.getByText(/progress-drag\.ts:88/)).toBeTruthy();
  });

  it("本文は畳める", () => {
    render(<PullRequestReviewFindings review={review()} pullRequestNumber={2851} />);

    fireEvent.click(screen.getByRole("button", { name: "レビュー本文" }));
    expect(screen.queryByText(/progress-drag\.ts:88/)).toBeNull();
  });

  it("古いコミットへのレビューは、本文より先に断る", () => {
    render(
      <PullRequestReviewFindings
        review={review({ isStale: true })}
        pullRequestNumber={2851}
      />,
    );

    expect(screen.getByText(/このレビューの後にコミットが積まれています/)).toBeTruthy();
    // 短縮したSHAを出す（どの時点のレビューかを確かめられるように）
    expect(screen.getByText("0123456")).toBeTruthy();
  });

  it("レビュー本文の記録が無ければ、その旨とPRへの導線だけを出す", () => {
    render(
      <PullRequestReviewFindings
        review={null}
        pullRequestNumber={2851}
        pullRequestUrl="https://github.com/guchi-apps/issue-deck/pull/2851"
        onImport={() => {}}
      />,
    );

    expect(screen.getByText(/レビュー本文の記録がありません/)).toBeTruthy();
    // 取り込む中身が無いので、ボタンは出さない
    expect(screen.queryByRole("button", { name: /修正依頼に取り込む/ })).toBeNull();
    expect(screen.getByRole("link", { name: /GitHubで読む/ }).getAttribute("href")).toBe(
      "https://github.com/guchi-apps/issue-deck/pull/2851",
    );
  });

  it("取り込みを渡さない画面ではボタンを出さない（マージ済みなど）", () => {
    render(<PullRequestReviewFindings review={review()} pullRequestNumber={2851} />);

    expect(screen.queryByRole("button", { name: /修正依頼に取り込む/ })).toBeNull();
  });

  it("取り込みボタンは押した内容を親へ渡し、済みが分かる文言へ変わる", () => {
    const onImport = vi.fn();
    const { rerender } = render(
      <PullRequestReviewFindings
        review={review()}
        pullRequestNumber={2851}
        onImport={onImport}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "指摘を修正依頼に取り込む" }));
    expect(onImport).toHaveBeenCalledTimes(1);

    rerender(
      <PullRequestReviewFindings
        review={review()}
        pullRequestNumber={2851}
        onImport={onImport}
        isImported
      />,
    );
    expect(screen.getByRole("button", { name: "もう一度取り込む" })).toBeTruthy();
  });
});
