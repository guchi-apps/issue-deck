// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GithubReferenceNavigationProvider } from "@/components/dashboard/github-reference-navigation";
import { IssuePullRequestList } from "@/components/dashboard/issue-pull-request-list";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { PullRequestLink } from "@/lib/github/pull-request-link";
import type { IssuePullRequest } from "@/types/pull-request";

function link(number: number): PullRequestLink {
  return { number, url: `https://github.com/m-guchi/issue-deck/pull/${number}` };
}

function pullRequest(overrides: Partial<IssuePullRequest> = {}): IssuePullRequest {
  return {
    number: 616,
    htmlUrl: "https://github.com/m-guchi/issue-deck/pull/616",
    title: "対応PRのタイトル",
    state: "open",
    draft: false,
    merged: false,
    ciStatus: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: true,
    repairRun: null,
    linkedIssueNumber: 600,
    reviewVerdict: null,
    headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    ...overrides,
  };
}

/** 内訳の工程名の要素から、同じ行の状態（✔・×・実施中・—・省略）を読む */
function stepStatus(stepName: HTMLElement): string | null {
  return stepName.parentElement?.lastElementChild?.textContent ?? null;
}

describe("IssuePullRequestList", () => {
  afterEach(() => {
    cleanup();
  });

  it("対応PRが無ければ何も描かない", () => {
    const { container } = render(
      <IssuePullRequestList links={[]} pullRequests={[]} mergeApprovalPending={false} />,
    );
    expect(container.textContent).toBe("");
  });

  it("複数の対応PRを行として並べる（#1339）", () => {
    render(
      <IssuePullRequestList
        links={[link(616), link(620)]}
        pullRequests={[
          pullRequest({ number: 616, title: "土台を入れる" }),
          pullRequest({ number: 620, title: "本体を実装する" }),
        ]}
        mergeApprovalPending={false}
      />,
    );

    expect(screen.getByText("#616")).not.toBeNull();
    expect(screen.getByText("土台を入れる")).not.toBeNull();
    expect(screen.getByText("#620")).not.toBeNull();
    expect(screen.getByText("本体を実装する")).not.toBeNull();
  });

  /**
   * #3333。PRを変更する操作（マージ・マージしない・修正依頼）はPR詳細だけが持つ。
   * Issue詳細の行に置くのは、アプリ内のPR詳細を開く導線だけ。
   */
  it("マージ待ちでも、行にはマージ・「マージしない」を出さない（#3333）", () => {
    render(
      <IssuePullRequestList links={[link(616)]} pullRequests={[pullRequest()]} mergeApprovalPending />,
    );
    expect(screen.queryByRole("button", { name: /マージする/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /マージしない/ })).toBeNull();
  });

  it("各行にPR詳細への導線を出す（#3333）", () => {
    render(
      <IssuePullRequestList
        links={[link(616), link(620)]}
        pullRequests={[pullRequest({ number: 616 }), pullRequest({ number: 620, state: "closed", merged: true })]}
        mergeApprovalPending={false}
      />,
    );
    const buttons = screen.getAllByRole("link", { name: /PR詳細で操作/ });
    expect(buttons.map((button) => button.getAttribute("href"))).toEqual([
      "https://github.com/m-guchi/issue-deck/pull/616",
      "https://github.com/m-guchi/issue-deck/pull/620",
    ]);
  });

  it("マージ待ちのときは、開いている行の導線を「PR詳細でマージ・修正依頼」にする（#3333）", () => {
    render(
      <IssuePullRequestList
        links={[link(616), link(620)]}
        pullRequests={[pullRequest({ number: 616, state: "closed", merged: true }), pullRequest({ number: 620 })]}
        mergeApprovalPending
      />,
    );
    // マージ済みの行はマージを待っていないので、強調しない
    expect(screen.getAllByRole("link", { name: /PR詳細で操作/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /PR詳細でマージ・修正依頼/ }).getAttribute("href")).toBe(
      "https://github.com/m-guchi/issue-deck/pull/620",
    );
    expect(screen.getByText("マージ・クローズ・修正依頼はPR詳細で行います。")).not.toBeNull();
  });

  it("導線を押すとGitHubではなくアプリ内のPR詳細を開く（#3333）", () => {
    const openReference = vi.fn();
    render(
      <GithubReferenceNavigationProvider openReference={openReference}>
        <IssuePullRequestList links={[link(616)]} pullRequests={[pullRequest()]} mergeApprovalPending />
      </GithubReferenceNavigationProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: /PR詳細でマージ・修正依頼/ }));
    expect(openReference).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryFullName: "m-guchi/issue-deck", number: 616, kind: "pull" }),
    );
  });

  it("詳細をまだ取得できていない行にも番号とPR詳細への導線を出す", () => {
    render(<IssuePullRequestList links={[link(616)]} pullRequests={[]} mergeApprovalPending />);
    expect(screen.getByText("#616")).not.toBeNull();
    expect(screen.getByRole("link", { name: /PR詳細でマージ・修正依頼/ })).not.toBeNull();
  });

  it("判定中の行は、待っているものを見出しの1語で出す（#2059・#3239）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[
          pullRequest({
            ciStatus: "success",
            mergeJudgement: {
              state: "pending",
              step: "claude-review",
              runUrl: "https://github.com/owner/repo/actions/runs/1/job/2",
              aiReview: AI_REVIEW_NONE,
            },
          }),
        ]}
        mergeApprovalPending
      />,
    );
    expect(screen.getByText("判定実施中")).toBeTruthy();
  });

  it("レビューが終わった行は、レビューの工程を✔で出し、実行ログへのリンクにする（#2150・#3239）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[
          pullRequest({
            ciStatus: "success",
            mergeJudgement: {
              state: "settled",
              step: null,
              runUrl: null,
              aiReview: {
                state: "passed",
                runUrl: "https://github.com/owner/repo/actions/runs/1/job/2",
              },
            },
          }),
        ]}
        mergeApprovalPending={false}
      />,
    );
    const step = screen.getByText("レビュー");
    // 実行ログへ行けるようリンクにする（バッジの頃と同じ）
    expect(step.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/owner/repo/actions/runs/1/job/2",
    );
    expect(stepStatus(step)).toBe("✔");
  });

  it("レビューが実行中の行は、工程名「レビュー」の状態を「実施中」で出す（#2150・#3239）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[
          pullRequest({
            ciStatus: "success",
            mergeJudgement: {
              state: "pending",
              step: "claude-review",
              runUrl: null,
              aiReview: { state: "pending", runUrl: null },
            },
          }),
        ]}
        mergeApprovalPending={false}
      />,
    );
    expect(screen.queryByText(/レビュー完了/)).toBeNull();
    expect(stepStatus(screen.getByText("レビュー"))).toBe("実施中");
  });

  it("開いているPRの行は、上部と同じ5工程を同じ順に出す（#3239）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[
          pullRequest({
            ciStatus: "success",
            mergeable: true,
            mergeJudgement: {
              state: "pending",
              step: "claude-review",
              runUrl: null,
              aiReview: { state: "pending", runUrl: null },
            },
          }),
        ]}
        mergeApprovalPending={false}
      />,
    );
    const steps = Array.from(
      screen.getByRole("list", { name: "developへマージの内訳" }).querySelectorAll("li"),
    ).map((item) => item.textContent);
    expect(steps).toEqual(["実装完了✔", "CI通過✔", "コンフリクト✔", "レビュー実施中", "マージ—"]);
    // 個別のバッジは内訳へ寄せた（同じ状態を2回言わない）
    expect(screen.queryByText("CI通過", { selector: "span.rounded-full" })).toBeNull();
  });

  it("レビューが省略された行は、記号（✔）ではなく「省略」と出す（#3239）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[
          pullRequest({
            mergeJudgement: {
              state: "settled",
              step: null,
              runUrl: null,
              aiReview: { state: "skipped", runUrl: null },
            },
          }),
        ]}
        mergeApprovalPending={false}
      />,
    );
    expect(stepStatus(screen.getByText("レビュー"))).toBe("省略");
  });

  it("レビューが失敗した行は「×」で出し、見出しにも失敗を出す（#3239）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[
          pullRequest({
            mergeJudgement: {
              state: "settled",
              step: null,
              runUrl: null,
              aiReview: { state: "failed", runUrl: null },
            },
          }),
        ]}
        mergeApprovalPending={false}
      />,
    );
    expect(stepStatus(screen.getByText("レビュー"))).toBe("×");
    expect(screen.getByText("レビュー失敗")).toBeTruthy();
  });

  it("マージ済み・下書き・クローズのPRの行には内訳を出さない（#3239）", () => {
    render(
      <IssuePullRequestList
        links={[link(616), link(617), link(618)]}
        pullRequests={[
          pullRequest({ number: 616, merged: true, state: "closed" }),
          pullRequest({ number: 617, draft: true }),
          pullRequest({ number: 618, state: "closed" }),
        ]}
        mergeApprovalPending={false}
      />,
    );
    expect(screen.queryByRole("list", { name: "developへマージの内訳" })).toBeNull();
  });

  it("コンフリクトしている行はバッジを出す（#2145）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        // PR画面では「コンフリクトあり」が出ているのに、Issue画面はCI状態しか出していなかった
        pullRequests={[pullRequest({ ciStatus: "success", mergeable: false })]}
        mergeApprovalPending
      />,
    );
    expect(screen.getByText("コンフリクトあり")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /マージする/ })).toBeNull();
  });

  it("自動修復が走っている行はその旨をバッジで出す（#2145）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[
          pullRequest({
            ciStatus: "success",
            mergeable: false,
            repairRun: {
              kind: "conflict",
              startedAt: new Date().toISOString(),
              runUrl: "https://github.com/owner/repo/actions/runs/1",
            },
          }),
        ]}
        mergeApprovalPending
      />,
    );
    expect(screen.getByText(/自動解消中/)).toBeTruthy();
  });

  it("絞り込みで落ちたPR（別Issueの言及）は行に出さない", () => {
    render(
      <IssuePullRequestList
        links={[link(616), link(1327)]}
        // #1327は別Issueに紐づくためselectIssuePullRequestsで落ちている
        pullRequests={[pullRequest({ number: 616 })]}
        mergeApprovalPending={false}
      />,
    );
    expect(screen.getByText("#616")).not.toBeNull();
    expect(screen.queryByText("#1327")).toBeNull();
  });

  it("noticeで渡した案内を一覧と同じ枠の中に出す（#1631）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[pullRequest()]}
        mergeApprovalPending
        notice={<p>自動マージされなかった理由</p>}
      />,
    );
    expect(screen.getByText("自動マージされなかった理由")).not.toBeNull();
  });

  it("対応PRが無ければnoticeも描かない（枠ごと出さない）", () => {
    const { container } = render(
      <IssuePullRequestList
        links={[]}
        pullRequests={[]}
        mergeApprovalPending
        notice={<p>自動マージされなかった理由</p>}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
