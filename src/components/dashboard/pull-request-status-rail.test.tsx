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
  const rail = container.querySelector("[aria-label='CI・Claudeのレビュー・マージの状況']");
  return Array.from(rail?.children ?? []).map((slot) => slot.textContent ?? "");
}

afterEach(cleanup);

describe("PullRequestStatusRail（#2942）", () => {
  it("枠は常にCI・Claudeのレビュー・マージの3つで、順番も変わらない", () => {
    const { container } = render(<PullRequestStatusRail pullRequest={withAiReview("passed")} />);
    expect(slotLabels(container)).toEqual(["CI通過", "レビュー完了", "マージ"]);
  });

  // 状態によって枠が増減すると、行をまたいだ列の位置がずれて縦に読み比べられなくなる。
  it("レビューのcheck-runが1件も無いPRでも枠を空けて3つに保つ", () => {
    const { container } = render(<PullRequestStatusRail pullRequest={withAiReview("none")} />);
    expect(slotLabels(container)).toEqual(["CI通過", "—", "マージ"]);
    // 「まだ来ていない」とは言わない——来ないため
    expect(screen.getByTitle(/Claudeのレビューが走りません/)).toBeTruthy();
  });

  it("Claudeのレビューは実行中・完了・省略・失敗を出し分ける", () => {
    for (const [state, label] of [
      ["pending", "レビュー中"],
      ["passed", "レビュー完了"],
      ["skipped", "レビュー省略"],
      ["failed", "レビュー失敗"],
    ] as const) {
      const { container } = render(<PullRequestStatusRail pullRequest={withAiReview(state)} />);
      expect(slotLabels(container)[1]).toBe(label);
      cleanup();
    }
  });

  // 短くしたのは主語だけで、全文は`title`から読める（#2942の懸念点への担保）
  it("短くした文言でも、全文と列の名前をtitleで読める", () => {
    render(<PullRequestStatusRail pullRequest={withAiReview("skipped")} />);
    expect(screen.getByTitle("Claudeのレビュー: Claudeのレビュー省略")).toBeTruthy();
  });

  it("レビューの実行ログが分かっていれば枠ごとリンクにする", () => {
    render(
      <PullRequestStatusRail
        pullRequest={withAiReview("failed", "https://github.com/owner/repo/actions/runs/1")}
      />,
    );
    const link = screen.getByRole("link", { name: /レビュー失敗/ }) as HTMLAnchorElement;
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
    expect(screen.getByText("レビュー失敗")).toBeTruthy();
  });

  it("CI失敗はそのままCIの枠に出る", () => {
    const { container } = render(
      <PullRequestStatusRail pullRequest={makePullRequest({ ciState: "failure" })} />,
    );
    expect(slotLabels(container)[0]).toBe("CI失敗");
  });

  it("ドラフトはCI状態も判定も取っていないため、CIの枠が「ドラフト」になる", () => {
    const { container } = render(
      <PullRequestStatusRail pullRequest={makePullRequest({ draft: true })} />,
    );
    expect(slotLabels(container)[0]).toBe("ドラフト");
  });

  // 止まっているもの（コンフリクト）は、放っておけば進むもの（判定中）より先に出す
  it("コンフリクトは判定中より優先してマージの枠に出る", () => {
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
    expect(slotLabels(container)[2]).toBe("コンフリクト");
  });

  it("判定中は段の名前ではなくボタンと同じ「判定中」を出す", () => {
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
    expect(slotLabels(container)[2]).toBe("判定中");
  });

  it("ユーザーがマージするしかないPRは「マージ待ち」、Auto-merge有効なら「自動マージ」", () => {
    const user = render(
      <PullRequestStatusRail pullRequest={makePullRequest({ linkedIssueCheckUser: true })} />,
    );
    expect(slotLabels(user.container)[2]).toBe("マージ待ち");
    cleanup();

    const auto = render(
      <PullRequestStatusRail pullRequest={makePullRequest({ autoMergeEnabled: true })} />,
    );
    expect(slotLabels(auto.container)[2]).toBe("自動マージ");
  });

  it("マージ済みのPRはマージの枠が「マージ済み」になる", () => {
    const { container } = render(
      <PullRequestStatusRail
        pullRequest={makePullRequest({ state: "closed", merged: true })}
      />,
    );
    expect(slotLabels(container)[2]).toBe("マージ済み");
  });
});
