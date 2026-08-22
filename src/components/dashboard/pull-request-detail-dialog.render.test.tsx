// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PullRequestDetailDialog } from "@/components/dashboard/pull-request-detail-dialog";
import type {
  PullRequestSummary,
  PullRequestDetail as PullRequestDetailData,
} from "@/types/pull-request";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    id: "guchi-apps/issue-deck#42",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 42,
    title: "確認待ちからPR詳細を開けるようにする",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/42",
    authorLogin: "claude",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-2149",
    kind: "issue",
    linkedIssueNumber: 2149,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null },
    mergeable: null,
    repairWorkflowAvailability: {},
    repairRun: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function makeDetail(): PullRequestDetailData {
  return {
    id: "guchi-apps/issue-deck#42",
    summary: makePullRequest(),
    body: "## 実装内容\n\nモーダルで開けるようにした。",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    commits: 1,
    events: [],
    fetchedAt: "2026-08-01T02:00:00.000Z",
  };
}

function renderDialog(
  overrides: Partial<{
    pullRequestId: string | null;
    pullRequest: PullRequestSummary | null;
    onClose: () => void;
  }> = {},
) {
  return render(
    <PullRequestDetailDialog
      pullRequestId={
        overrides.pullRequestId === undefined ? "guchi-apps/issue-deck#42" : overrides.pullRequestId
      }
      pullRequest={
        overrides.pullRequest === undefined ? makePullRequest() : overrides.pullRequest
      }
      detail={makeDetail()}
      isLoading={false}
      error={null}
      onRefresh={vi.fn()}
      onMerged={vi.fn()}
      onClose={overrides.onClose ?? vi.fn()}
    />,
  );
}

describe("PullRequestDetailDialog", () => {
  beforeEach(() => {
    // 本番デプロイ状況の取得（#1814）。バッジを出さない「判定できない」を返す
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: null, fetchedAt: "2026-08-01T02:00:00.000Z" }),
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("idがnullのあいだは何も出さない", () => {
    renderDialog({ pullRequestId: null, pullRequest: null });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("開いているとPRのタイトルと本文を出す", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "#42 確認待ちからPR詳細を開けるようにする" }),
    ).toBeTruthy();
    expect(screen.getByText("モーダルで開けるようにした。")).toBeTruthy();
  });

  it("バツボタンで閉じる", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByLabelText("閉じる"));
    expect(onClose).toHaveBeenCalled();
  });

  it("ヘッダーの材料が届く前でも読み込み中として開く（一覧に無いPRを開いた場合）", () => {
    renderDialog({ pullRequest: null });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("閉じる")).toBeTruthy();
  });
});
