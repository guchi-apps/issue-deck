// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MergePendingPullRequests } from "@/components/dashboard/merge-pending-pull-requests";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { PullRequestSummary } from "@/types/pull-request";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null,
    ciChecks: [],
    id: "owner/repo#10",
    repositoryFullName: "owner/repo",
    repositoryPrivate: false,
    number: 10,
    title: "v1.0.0をmainへリリースする",
    htmlUrl: "https://github.com/owner/repo/pull/10",
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "main",
    headRef: "develop",
    headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    kind: "release",
    linkedIssueNumber: null,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
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

afterEach(() => {
  cleanup();
});

describe("MergePendingPullRequestsの「更新」（#2175）", () => {
  it("`onRefresh`を渡された画面だけにボタンが出て、押すと取り直す", () => {
    // 一覧を指で引っ張れないPC向けの導線。スマホは引っ張って更新が同じ取り直しを呼ぶ
    const onRefresh = vi.fn();
    render(
      <MergePendingPullRequests
        pullRequests={[makePullRequest()]}
        onSelectPullRequest={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更新" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("`onRefresh`が無ければボタンを出さない", () => {
    render(
      <MergePendingPullRequests pullRequests={[makePullRequest()]} onSelectPullRequest={vi.fn()} />,
    );

    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });

  it("押せるPRが無く完了待ちだけのときも取り直せる", () => {
    // CIが終わったかどうかを確かめたいのはむしろこの状態のため、薄い1行に落としても残す
    const onRefresh = vi.fn();
    render(
      <MergePendingPullRequests
        pullRequests={[]}
        waitingForChecksCount={2}
        onSelectPullRequest={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText(/CI・判定の完了待ちが2件あります/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  // PR一覧と同じレールを出す（#2942）。同じPRなのに画面ごとに違う出し方になると、
  // どちらが新しいのかを読む側が判断できなくなる（#2145と同じ理由）。
  it("PR一覧と同じステータスレールを出し、リンクにはしない", () => {
    render(
      <MergePendingPullRequests
        pullRequests={[
          makePullRequest({
            ciState: "success",
            mergeJudgement: {
              state: "settled",
              step: null,
              runUrl: null,
              aiReview: { state: "failed", runUrl: "https://github.com/owner/repo/actions/runs/1" },
            },
          }),
        ]}
        onSelectPullRequest={vi.fn()}
      />,
    );

    const rail = document.querySelector("[aria-label='CI・コンフリクト・レビューの状況']");
    expect(Array.from(rail?.children ?? []).map((slot) => slot.textContent)).toEqual([
      "CI✔",
      "コンフリクト実施中",
      "レビュー×",
    ]);
    // カード全体が<button>なので、中に<a>を置くとHTMLとして不正になる
    expect(rail?.querySelector("a")).toBeNull();
  });

  it("取り直している間はボタンを押せない", () => {
    const onRefresh = vi.fn();
    render(
      <MergePendingPullRequests
        pullRequests={[makePullRequest()]}
        onSelectPullRequest={vi.fn()}
        onRefresh={onRefresh}
        isRefreshing
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更新" }));

    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("MergePendingPullRequestsの折りたたみ（#3165）", () => {
  function makeMany(count: number): PullRequestSummary[] {
    return Array.from({ length: count }, (_, index) =>
      makePullRequest({
        id: `owner/repo${index}#${index + 1}`,
        repositoryFullName: `owner/repo${index}`,
        number: index + 1,
        title: `v1.0.${index}をmainへリリースする`,
      }),
    );
  }

  /** 並んでいるPRカードの数。完了待ちの1行や開閉ボタンは数えない */
  function listedCount(): number {
    return document.querySelectorAll("#merge-pending-list > li").length;
  }

  it("3件までならそのまま並べ、開閉ボタンを出さない", () => {
    render(
      <MergePendingPullRequests pullRequests={makeMany(3)} onSelectPullRequest={vi.fn()} />,
    );

    expect(listedCount()).toBe(3);
    expect(screen.queryByRole("button", { name: /件を表示/ })).toBeNull();
  });

  it("4件以上は先頭3件だけ並べ、残りを「他N件を表示」で開ける", () => {
    render(
      <MergePendingPullRequests pullRequests={makeMany(11)} onSelectPullRequest={vi.fn()} />,
    );

    expect(listedCount()).toBe(3);

    fireEvent.click(screen.getByRole("button", { name: "他8件を表示" }));
    expect(listedCount()).toBe(11);

    fireEvent.click(screen.getByRole("button", { name: "先頭3件だけ表示" }));
    expect(listedCount()).toBe(3);
  });

  it("畳んでいても、見出しには並べている数ではなく総件数を出す", () => {
    render(
      <MergePendingPullRequests pullRequests={makeMany(11)} onSelectPullRequest={vi.fn()} />,
    );

    expect(screen.getByText("あなたのマージを待っているPull Request").textContent).toContain(
      "11件",
    );
  });

  it("保留中の並び（#2398）は畳まない", () => {
    // 「保留中N件」を開いた中身で、開いたのは中を見るためなので、そこでまた畳むと意味が無い
    render(
      <MergePendingPullRequests
        pullRequests={makeMany(11)}
        onSelectPullRequest={vi.fn()}
        snoozed={{
          snoozes: new Map(),
          now: Date.parse("2026-08-01T00:00:00Z"),
          onUnsnooze: vi.fn(),
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: /件を表示/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "解除" })).toHaveLength(11);
  });
});

describe("MergePendingPullRequestsの対応Issueの印（#3345）", () => {
  const developPullRequest = makePullRequest({
    id: "owner/repo#20",
    number: 20,
    title: "気温データカードの高さを縮小する",
    kind: "issue",
    baseRef: "develop",
    headRef: "issue-465",
    linkedIssueNumber: 465,
  });

  it("対応Issueが確認待ちに並んでいるPRにだけ印を出す", () => {
    render(
      <MergePendingPullRequests
        pullRequests={[makePullRequest(), developPullRequest]}
        listedIssueKeys={new Set(["owner/repo#465"])}
        onSelectPullRequest={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/下の一覧にもあります/)).toHaveLength(1);
    expect(screen.getByText("対応Issue #465・下の一覧にもあります")).toBeTruthy();
  });

  it("対応Issueが並んでいなければ印を出さない", () => {
    render(
      <MergePendingPullRequests
        pullRequests={[developPullRequest]}
        listedIssueKeys={new Set(["owner/other#465"])}
        onSelectPullRequest={vi.fn()}
      />,
    );

    expect(screen.queryByText(/下の一覧にもあります/)).toBeNull();
  });
});
