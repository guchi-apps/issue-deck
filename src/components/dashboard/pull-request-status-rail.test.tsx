// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PullRequestStatusRail } from "@/components/dashboard/pull-request-status-rail";
import { AI_REVIEW_NONE, type AiReviewState } from "@/lib/github/check-rollup";
import type { PullRequestSummary } from "@/types/pull-request";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null,
    ciChecks: [],
    id: "guchi-apps/issue-deck#1",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 1,
    title: "PRのタイトル",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/1",
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-1",
    headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    kind: "issue",
    linkedIssueNumber: 1,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "settled", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: null,
    repairWorkflowAvailability: {},
    repairRun: null,
    reviewVerdict: null,
    releaseVerification: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function withAiReview(state: AiReviewState, runUrl: string | null = null) {
  return makePullRequest({
    mergeJudgement: { state: "settled", step: null, runUrl: null, aiReview: { state, runUrl } },
  });
}

/** 枠の並びを左から読む。**列の位置が固定されていること**がこのコンポーネントの目的 */
function slotLabels(container: HTMLElement): string[] {
  const rail = container.querySelector("[aria-label='CI・コンフリクト・レビューの状況']");
  return Array.from(rail?.children ?? []).map((slot) => slot.textContent ?? "");
}

afterEach(cleanup);

describe("PullRequestStatusRail（#2942）", () => {
  it("項目は常にCI・コンフリクト・レビューの3つで、順番も変わらない", () => {
    const { container } = render(<PullRequestStatusRail pullRequest={withAiReview("passed")} />);
    expect(slotLabels(container)).toEqual(["CI✔", "コンフリクト実施中", "レビュー✔"]);
  });

  // 状態によって枠が増減すると、行をまたいだ列の位置がずれて縦に読み比べられなくなる。
  it("レビューのcheck-runが1件も無いPRでも枠を空けて3つに保つ", () => {
    const { container } = render(<PullRequestStatusRail pullRequest={withAiReview("none")} />);
    expect(slotLabels(container)).toEqual(["CI✔", "コンフリクト実施中", "レビュー—"]);
    // 「まだ来ていない」とは言わない——来ないため
    expect(screen.getByTitle(/レビュー工程がありません/)).toBeTruthy();
  });

  it("レビューは実行中・完了・省略・失敗を状態記号で出し分ける", () => {
    for (const [state, label] of [
      ["pending", "レビュー実施中"],
      ["passed", "レビュー✔"],
      ["skipped", "レビュー省略"],
      ["failed", "レビュー×"],
    ] as const) {
      const { container } = render(<PullRequestStatusRail pullRequest={withAiReview(state)} />);
      expect(slotLabels(container)[2]).toBe(label);
      cleanup();
    }
  });

  it("状態記号でも、補助テキストからレビューの結果を読める", () => {
    render(<PullRequestStatusRail pullRequest={withAiReview("skipped")} />);
    expect(screen.getByTitle("レビュー: レビュー省略")).toBeTruthy();
  });

  it("レビューの実行ログが分かっていれば枠ごとリンクにする", () => {
    render(
      <PullRequestStatusRail
        pullRequest={withAiReview("failed", "https://github.com/owner/repo/actions/runs/1")}
      />,
    );
    const link = screen.getByRole("link", { name: /レビュー/ }) as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/owner/repo/actions/runs/1");
  });

  // カード全体が<button>の場所（確認待ちのマージ待ちカード）で<a>を入れるとHTMLとして不正になる
  it("linkable=false ではリンクにしない", () => {
    render(
      <PullRequestStatusRail
        linkable={false}
        pullRequest={withAiReview("failed", "https://github.com/owner/repo/actions/runs/1")}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("×")).toBeTruthy();
  });

  it("CI失敗はそのままCIの枠に出る", () => {
    const { container } = render(
      <PullRequestStatusRail pullRequest={makePullRequest({ ciState: "failure" })} />,
    );
    expect(slotLabels(container)[0]).toBe("CI×");
  });

  it("ドラフトはCI状態も判定も取っていないため、CIの枠が「ドラフト」になる", () => {
    const { container } = render(
      <PullRequestStatusRail pullRequest={makePullRequest({ draft: true })} />,
    );
    expect(slotLabels(container)[0]).toBe("CI—");
  });

  it("コンフリクトは専用の項目に×で出る", () => {
    const { container } = render(
      <PullRequestStatusRail
        pullRequest={makePullRequest({
          mergeable: false,
          mergeJudgement: {
            state: "pending",
            step: "auto-merge",
            runUrl: null,
            aiReview: AI_REVIEW_NONE,
          },
        })}
      />,
    );
    expect(slotLabels(container)[1]).toBe("コンフリクト×");
  });

  it("コンフリクトの確認中は「実施中」で出る", () => {
    const { container } = render(
      <PullRequestStatusRail
        pullRequest={makePullRequest({
          mergeJudgement: {
            state: "pending",
            step: "claude-review",
            runUrl: null,
            aiReview: AI_REVIEW_NONE,
          },
        })}
      />,
    );
    expect(slotLabels(container)[1]).toBe("コンフリクト実施中");
  });
});
