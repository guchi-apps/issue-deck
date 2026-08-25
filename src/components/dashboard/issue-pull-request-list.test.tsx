// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    ...overrides,
  };
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

  it("マージ待ちでなければマージボタンを出さない", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[pullRequest()]}
        mergeApprovalPending={false}
        onMerge={async () => true}
      />,
    );
    expect(screen.queryByRole("button", { name: /マージする/ })).toBeNull();
  });

  it("マージ待ちのopenなPRの行にだけマージボタンを出す（#1339）", () => {
    render(
      <IssuePullRequestList
        links={[link(616), link(620)]}
        pullRequests={[
          pullRequest({ number: 616, state: "closed", merged: true }),
          pullRequest({ number: 620 }),
        ]}
        mergeApprovalPending
        onMerge={async () => true}
      />,
    );

    // マージ済みの行は押せない「マージ済み」、openの行が押せる「マージする」
    expect(screen.getByText("マージ済み", { selector: "span" })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /マージする/ })).toHaveLength(1);
  });

  it("下書き・クローズ済みのPRにはマージボタンを出さない", () => {
    render(
      <IssuePullRequestList
        links={[link(616), link(620)]}
        pullRequests={[
          pullRequest({ number: 616, draft: true, ciStatus: null }),
          pullRequest({ number: 620, state: "closed", merged: false, ciStatus: null }),
        ]}
        mergeApprovalPending
        onMerge={async () => true}
      />,
    );
    expect(screen.queryByRole("button", { name: /マージする/ })).toBeNull();
  });

  it("CI実行中の行のマージボタンは押せない", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[pullRequest({ ciStatus: "in_progress" })]}
        mergeApprovalPending
        onMerge={async () => true}
      />,
    );
    const button = screen.getByRole("button", { name: /マージする/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("自動マージ可否の判定中の行はマージボタンを押せない（#1968）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        // CIは通っているが判定はまだ走っている状態（PR #1959の再現）。
        pullRequests={[
          pullRequest({
            ciStatus: "success",
            mergeJudgement: { state: "pending", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
          }),
        ]}
        mergeApprovalPending
        onMerge={async () => true}
      />,
    );
    const button = screen.getByRole("button", { name: /判定中/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("判定中の行は待っている段階をバッジで出す（#2059）", () => {
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
        onMerge={async () => true}
      />,
    );
    expect(screen.getByText("Claudeがレビュー中")).toBeTruthy();
  });

  it("Claudeのレビューが終わった行はバッジを出す（#2150）", () => {
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
    const badge = screen.getByText("Claudeのレビュー完了");
    // 実行ログへ行けるようリンクにする（他のバッジと同じ形）
    expect(badge.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/owner/repo/actions/runs/1/job/2",
    );
  });

  // 実行中の言い回しは「Claudeがレビュー中」が持っており、二重に出さない（#2150）。
  it("Claudeのレビューが実行中の行には完了バッジを出さない（#2150）", () => {
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
    expect(screen.queryByText(/Claudeのレビュー/)).toBeNull();
    expect(screen.getByText("Claudeがレビュー中")).toBeTruthy();
  });

  it("コンフリクトしている行はバッジを出し、マージボタンを出さない（#2145）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        // PR画面では「コンフリクトあり」が出ているのに、Issue画面はCI状態しか出していなかった
        pullRequests={[pullRequest({ ciStatus: "success", mergeable: false })]}
        mergeApprovalPending
        onMerge={async () => true}
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
        onMerge={async () => true}
      />,
    );
    expect(screen.getByText(/自動解消中/)).toBeTruthy();
  });

  it("コンフリクトの判定前（null）はマージボタンを出したままにする（#2145）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[pullRequest({ mergeable: null })]}
        mergeApprovalPending
        onMerge={async () => true}
      />,
    );
    expect(screen.queryByText("コンフリクトあり")).toBeNull();
    expect(screen.getByRole("button", { name: /マージする/ })).toBeTruthy();
  });

  it("マージするとその行のPR番号でonMerge・onMergedを呼ぶ", async () => {
    const onMerge = vi.fn(async () => true);
    const onMerged = vi.fn();
    render(
      <IssuePullRequestList
        links={[link(616), link(620)]}
        pullRequests={[pullRequest({ number: 616 }), pullRequest({ number: 620 })]}
        mergeApprovalPending
        onMerge={onMerge}
        onMerged={onMerged}
      />,
    );

    // 2行目（#620）のマージボタンを押す
    fireEvent.click(screen.getAllByRole("button", { name: /マージする/ })[1]);
    fireEvent.click(screen.getAllByRole("button", { name: /マージする/ }).at(-1)!);

    await waitFor(() => {
      expect(onMerged).toHaveBeenCalledWith(620);
    });
    expect(onMerge).toHaveBeenCalledWith(620);
  });

  it("この画面でマージしたPRは、GitHub側の反映前でも「マージ済み」になる", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[pullRequest()]}
        mergeApprovalPending
        onMerge={async () => true}
        mergedNumbers={new Set([616])}
      />,
    );
    const button = screen.getByRole("button", { name: /マージ済み/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("詳細をまだ取得できていなくても番号とマージボタンは出す（取得失敗でマージ不能にしない）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[]}
        mergeApprovalPending
        onMerge={async () => true}
      />,
    );
    expect(screen.getByText("#616")).not.toBeNull();
    const button = screen.getByRole("button", { name: /マージする/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("詳細の取得が終わるまではマージボタンを「確認中」で押せなくする（#2352）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[]}
        isLoadingDetails
        mergeApprovalPending
        onMerge={async () => true}
      />,
    );
    expect(screen.getByText("#616")).not.toBeNull();
    const button = screen.getByRole("button", { name: /確認中/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("詳細が届いている行は取得中でも押せる（判定は行ごと。#2352）", () => {
    render(
      <IssuePullRequestList
        links={[link(616)]}
        pullRequests={[pullRequest({ number: 616 })]}
        isLoadingDetails
        mergeApprovalPending
        onMerge={async () => true}
      />,
    );
    const button = screen.getByRole("button", { name: /マージする/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
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

  it("マージ失敗のエラーは対象の行に出す", () => {
    render(
      <IssuePullRequestList
        links={[link(616), link(620)]}
        pullRequests={[pullRequest({ number: 616 }), pullRequest({ number: 620 })]}
        mergeApprovalPending
        onMerge={async () => true}
        mergeTargetNumber={620}
        mergeError="コンフリクトしています"
      />,
    );
    expect(screen.getAllByText("コンフリクトしています")).toHaveLength(1);
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
