// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssuePullRequestList } from "@/components/dashboard/issue-pull-request-list";
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
});
