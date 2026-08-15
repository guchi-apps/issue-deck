// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestDetail } from "@/components/dashboard/pull-request-detail";
import type {
  PullRequestSummary,
  PullRequestDetail as PullRequestDetailData,
  PullRequestEvent,
} from "@/types/pull-request";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    id: "guchi-apps/issue-deck#42",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 42,
    title: "PRの内容を確認できるようにする",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/42",
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-1087",
    kind: "issue",
    linkedIssueNumber: 1087,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<PullRequestEvent> = {}): PullRequestEvent {
  return {
    id: "comment-1",
    kind: "comment",
    authorLogin: "claude",
    body: "実装が完了しました。",
    createdAt: "2026-08-01T01:00:00Z",
    reviewState: null,
    path: null,
    line: null,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<PullRequestDetailData> = {}): PullRequestDetailData {
  return {
    id: "guchi-apps/issue-deck#42",
    summary: makePullRequest(),
    body: "## 実装内容\n\nPR詳細ペインを追加した。",
    additions: 120,
    deletions: 8,
    changedFiles: 5,
    commits: 2,
    mergeable: true,
    events: [makeEvent()],
    ...overrides,
  };
}

function renderDetail(
  overrides: Partial<{
    pullRequest: PullRequestSummary | null;
    detail: PullRequestDetailData | null;
    isLoading: boolean;
    error: string | null;
  }> = {},
) {
  return render(
    <PullRequestDetail
      pullRequest={
        overrides.pullRequest === undefined ? makePullRequest() : overrides.pullRequest
      }
      detail={overrides.detail === undefined ? makeDetail() : overrides.detail}
      isLoading={overrides.isLoading ?? false}
      error={overrides.error ?? null}
      onRefresh={vi.fn()}
      onMerged={vi.fn()}
    />,
  );
}

describe("PullRequestDetail", () => {
  afterEach(() => {
    cleanup();
  });

  it("未選択のときは選択を促す", () => {
    renderDetail({ pullRequest: null, detail: null });
    expect(screen.getByText("PRを選ぶと本文とコメントを表示します。")).toBeTruthy();
  });

  it("本文・差分統計・コメントを表示する", () => {
    renderDetail();
    expect(screen.getByText("実装内容")).toBeTruthy();
    expect(screen.getByText("PR詳細ペインを追加した。")).toBeTruthy();
    expect(screen.getByText("+120")).toBeTruthy();
    expect(screen.getByText("-8")).toBeTruthy();
    expect(screen.getByText(/5ファイル ・ 2コミット/)).toBeTruthy();
    expect(screen.getByText("コメント 1件")).toBeTruthy();
    expect(screen.getByText("実装が完了しました。")).toBeTruthy();
  });

  it("本文が空のPRはその旨を出す", () => {
    renderDetail({ detail: makeDetail({ body: "", events: [] }) });
    expect(screen.getByText("本文はありません。")).toBeTruthy();
    expect(screen.getByText("コメントはまだありません。")).toBeTruthy();
  });

  it("レビューは結果、レビューコメントは対象ファイルと行を出す", () => {
    renderDetail({
      detail: makeDetail({
        events: [
          makeEvent({ id: "review-1", kind: "review", reviewState: "changes_requested", body: "修正してください。" }),
          makeEvent({
            id: "review-comment-1",
            kind: "review-comment",
            path: "src/lib/foo.ts",
            line: 12,
            body: "この分岐は不要です。",
          }),
        ],
      }),
    });

    expect(screen.getByText("変更を要求")).toBeTruthy();
    expect(screen.getByText("src/lib/foo.ts:12")).toBeTruthy();
  });

  it("コンフリクトしているPRは警告を出す", () => {
    renderDetail({ detail: makeDetail({ mergeable: false }) });
    expect(screen.getByText("コンフリクトあり")).toBeTruthy();
  });

  it("自動でマージされないPRには「ユーザーのマージが必要です」を出す（#1469）", () => {
    renderDetail({ pullRequest: makePullRequest({ linkedIssueCheckUser: true }) });
    expect(screen.getByText("ユーザーのマージが必要です")).toBeTruthy();
    cleanup();

    renderDetail();
    expect(screen.queryByText("ユーザーのマージが必要です")).toBeNull();
  });

  it("別のPRの取得結果は表示しない", () => {
    renderDetail({ detail: makeDetail({ id: "guchi-apps/issue-deck#41" }) });
    expect(screen.queryByText("PR詳細ペインを追加した。")).toBeNull();
  });

  it("draft以外にはマージボタンを出し、draftには出さない", () => {
    renderDetail();
    expect(screen.getByRole("button", { name: "マージする" })).toBeTruthy();
    cleanup();

    renderDetail({ pullRequest: makePullRequest({ draft: true }) });
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  it("取得に失敗したときはエラーを表示する", () => {
    renderDetail({ detail: null, error: "リクエストに失敗しました (502)" });
    expect(screen.getByText("リクエストに失敗しました (502)")).toBeTruthy();
  });

  // 画面内のリンクからは一覧に載っていないPR（マージ済み・クローズ済み）も開ける（#1260）
  it("マージ済みPRはその旨を出し、マージボタンを出さない", () => {
    renderDetail({
      pullRequest: makePullRequest({ state: "closed", merged: true }),
      detail: makeDetail({ mergeable: null }),
    });
    expect(screen.getByText("マージ済み")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  it("マージされずクローズされたPRはその旨を出し、マージボタンを出さない", () => {
    renderDetail({
      pullRequest: makePullRequest({ state: "closed", merged: false }),
      detail: makeDetail({ mergeable: null }),
    });
    expect(screen.getByText("クローズ済み")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  it("summaryが未取得のうちは読み込み中として見せる（PRを選ぶ促しは出さない）", () => {
    renderDetail({ pullRequest: null, detail: null, isLoading: true });
    expect(screen.getByText("読み込み中...")).toBeTruthy();
    expect(screen.queryByText("PRを選ぶと本文とコメントを表示します。")).toBeNull();
  });

  it("summaryを取得できなかった場合はエラーを表示する", () => {
    renderDetail({
      pullRequest: null,
      detail: null,
      error: "このPull Requestは見つかりませんでした",
    });
    expect(screen.getByText("Pull Requestを開けませんでした")).toBeTruthy();
    expect(screen.getByText("このPull Requestは見つかりませんでした")).toBeTruthy();
  });
});
