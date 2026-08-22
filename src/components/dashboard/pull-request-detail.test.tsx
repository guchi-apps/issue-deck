// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PullRequestDetail } from "@/components/dashboard/pull-request-detail";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type {
  PullRequestDeployStatus,
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
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: null,
    repairWorkflowAvailability: {},
    repairRun: null,
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
    events: [makeEvent()],
    fetchedAt: "2026-08-01T02:00:00.000Z",
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

/** 本番デプロイ状況の取得（#1814）。既定では「判定できない」を返し、バッジを出さない */
function mockDeployStatus(status: PullRequestDeployStatus | null = null) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ status, fetchedAt: "2026-08-16T12:00:00.000Z" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PullRequestDetail", () => {
  beforeEach(() => {
    mockDeployStatus();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("未選択のときは選択を促す", () => {
    renderDetail({ pullRequest: null, detail: null });
    expect(screen.getByText("PRを選ぶと本文とコメントを表示します。")).toBeTruthy();
  });

  it("本文・差分統計・コメントを表示する", () => {
    renderDetail();
    expect(screen.getByText("実装内容")).toBeTruthy();
    expect(screen.getByText("PR詳細ペインを追加した。")).toBeTruthy();
    // 増減はヘッダーの統計と「変更ファイル」の見出し（#1987）の2か所に出る。長い本文の
    // 下まで読み進めても規模が分かるようにしているため、重複はそのまま許容する。
    expect(screen.getAllByText("+120")).toHaveLength(2);
    expect(screen.getAllByText("-8")).toHaveLength(2);
    expect(screen.getByText(/5ファイル ・ 2コミット/)).toBeTruthy();
    expect(screen.getByText("変更ファイル")).toBeTruthy();
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

  // `mergeable`は詳細ではなくsummaryが持つ（一覧・詳細で同じ判定にするため。#1742）
  it("コンフリクトしているPRは警告と自動解消ボタンを出し、マージボタンを出さない", () => {
    renderDetail({ pullRequest: makePullRequest({ mergeable: false }) });
    expect(screen.getByText("コンフリクトあり")).toBeTruthy();
    expect(screen.getByRole("button", { name: "コンフリクトを自動解消" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  it("自動でマージされないPRには「ユーザーのマージが必要です」を出す（#1469）", () => {
    renderDetail({ pullRequest: makePullRequest({ linkedIssueCheckUser: true }) });
    expect(screen.getByText("ユーザーのマージが必要です")).toBeTruthy();
    cleanup();

    renderDetail();
    expect(screen.queryByText("ユーザーのマージが必要です")).toBeNull();
  });

  it("Claudeのレビューが終わったPRはCI状態の隣にバッジを出す（#2150）", () => {
    renderDetail({
      pullRequest: makePullRequest({
        mergeJudgement: {
          state: "settled",
          step: null,
          runUrl: null,
          aiReview: { state: "passed", runUrl: null },
        },
      }),
    });
    expect(screen.getByText("CI通過")).toBeTruthy();
    expect(screen.getByText("Claudeのレビュー完了")).toBeTruthy();
  });

  // 差分が小さくレビューが走らなかったことを言い切る。何も出さないと未完了と区別が付かない。
  it("レビューが実行されなかったPRは「省略」と出す（#2150）", () => {
    renderDetail({
      pullRequest: makePullRequest({
        mergeJudgement: {
          state: "settled",
          step: null,
          runUrl: null,
          aiReview: { state: "skipped", runUrl: null },
        },
      }),
    });
    expect(screen.getByText("Claudeのレビュー省略")).toBeTruthy();
  });

  it("レビューのcheck-runが無いPRにはバッジを出さない（#2150）", () => {
    renderDetail();
    expect(screen.queryByText(/^Claudeのレビュー/)).toBeNull();
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
    });
    expect(screen.getByText("マージ済み")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  it("マージされずクローズされたPRはその旨を出し、マージボタンを出さない", () => {
    renderDetail({
      pullRequest: makePullRequest({ state: "closed", merged: false }),
    });
    expect(screen.getByText("クローズ済み")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "マージする" })).toBeNull();
  });

  // 本番へ届いたかをPR詳細で分かるようにする（#1814）
  it("マージ済みPRには本番デプロイ状況のバッジを出し、実行ログへリンクする", async () => {
    mockDeployStatus({
      kind: "deployed",
      version: "4.1.0",
      releasePullRequestNumber: 100,
      deployRunUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
    });
    renderDetail({ pullRequest: makePullRequest({ state: "closed", merged: true }) });

    const badge = await screen.findByText("本番反映済み v4.1.0");
    expect(badge.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/guchi-apps/issue-deck/actions/runs/1",
    );
  });

  it("判定できないときはバッジを出さない（未反映と言い切らない）", async () => {
    const fetchMock = mockDeployStatus(null);
    renderDetail({ pullRequest: makePullRequest({ state: "closed", merged: true }) });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/本番/)).toBeNull();
    expect(screen.queryByText(/デプロイ/)).toBeNull();
  });

  it("未マージのPRではデプロイ状況を取りに行かない", async () => {
    const fetchMock = mockDeployStatus({
      kind: "deployed",
      version: "4.1.0",
      releasePullRequestNumber: 100,
      deployRunUrl: null,
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText("コメント 1件")).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("本番反映済み v4.1.0")).toBeNull();
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
