// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BulkCreateCodeReviewIssuesDialog } from "@/components/dashboard/bulk-create-code-review-issues-dialog";
import { CODE_REVIEW_REPORT_MARKER, parseCodeReviewReport } from "@/lib/github/code-review";
import type { Issue } from "@/types/issue";

// フックの戻り値は毎レンダー同じ参照を返す（create-issue-dialog.render.test.tsxと同じ考え方）
const createIssue = vi.fn();
const issueMutations = {
  createIssue,
  updateIssue: vi.fn(),
  isSubmitting: false,
  error: null as string | null,
  setError: vi.fn(),
};

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => issueMutations,
}));

const REPOSITORY_FULL_NAME = "guchi-apps/issue-deck";

const REPORT_BODY = `${CODE_REVIEW_REPORT_MARKER}
読んだコード: guchi-apps/issue-deck origin/develop 9b25283b・2026-09-07

### [重大] 未完了ジョブの判定が種別を見ていない

- 種別: correctness
- 場所: src/lib/dispatch/dispatch-job.ts:412

本文1

### [中] キャッシュキーがブランチ名を含んでいない

- 場所: src/lib/github/code-review-report-cache.ts:33

本文2

### [軽微] 分岐が読みにくい

- 場所: src/lib/github/code-review.ts:345

本文3
`;

function findings() {
  const report = parseCodeReviewReport(REPORT_BODY);
  if (!report) throw new Error("テスト用のレビュー結果を読めませんでした");
  return report.findings;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 3000,
    title: "未完了ジョブの判定が種別を見ていない",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: REPOSITORY_FULL_NAME,
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "guchi", avatarUrl: "" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    projectStatus: null,
    htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}/issues/3000`,
    favorite: false,
    excludedFromIssueCreation: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

describe("BulkCreateCodeReviewIssuesDialog（#2859）", () => {
  beforeEach(() => {
    issueMutations.isSubmitting = false;
    issueMutations.error = null;
    createIssue.mockReset();
  });

  afterEach(cleanup);

  // 軽微は選ぶ手間を減らすため、開いた時点では既定で外しておく
  it("軽微は既定で選択しない。ボタンは選択中の件数を出す", () => {
    render(
      <BulkCreateCodeReviewIssuesDialog
        open
        onOpenChange={vi.fn()}
        findings={findings()}
        repositoryFullName={REPOSITORY_FULL_NAME}
        reviewNumber={370}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "2件のIssueを作成" })).toBeTruthy();
  });

  it("選び直すと件数が変わる", () => {
    render(
      <BulkCreateCodeReviewIssuesDialog
        open
        onOpenChange={vi.fn()}
        findings={findings()}
        repositoryFullName={REPOSITORY_FULL_NAME}
        reviewNumber={370}
        onCreated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("分岐が読みにくい"));
    expect(screen.getByRole("button", { name: "3件のIssueを作成" })).toBeTruthy();
  });

  it("選んだ指摘を直列で作成し、それぞれonCreatedへ渡してから閉じる", async () => {
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    createIssue
      .mockResolvedValueOnce(makeIssue({ id: "1", number: 3001 }))
      .mockResolvedValueOnce(makeIssue({ id: "2", number: 3002 }));

    render(
      <BulkCreateCodeReviewIssuesDialog
        open
        onOpenChange={onOpenChange}
        findings={findings()}
        repositoryFullName={REPOSITORY_FULL_NAME}
        reviewNumber={370}
        onCreated={onCreated}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2件のIssueを作成" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2));
    expect(createIssue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        repositoryFullName: REPOSITORY_FULL_NAME,
        title: "未完了ジョブの判定が種別を見ていない",
        labels: [],
        assignee: null,
      }),
    );
    expect(createIssue).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: "キャッシュキーがブランチ名を含んでいない" }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  // 途中で失敗したら残りは作らない。成功した分はonCreatedで反映済みなので取り消さない
  it("途中で失敗したら残りを止め、ダイアログは閉じない", async () => {
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    createIssue.mockResolvedValueOnce(makeIssue({ id: "1", number: 3001 })).mockResolvedValueOnce(null);

    render(
      <BulkCreateCodeReviewIssuesDialog
        open
        onOpenChange={onOpenChange}
        findings={findings()}
        repositoryFullName={REPOSITORY_FULL_NAME}
        reviewNumber={370}
        onCreated={onCreated}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2件のIssueを作成" }));

    await waitFor(() => expect(createIssue).toHaveBeenCalledTimes(2));
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
