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

const repoMeta = {
  labels: [
    { name: "30.bug", color: "d73a4a", description: null },
    { name: "51.improvement", color: "a2eeef", description: null },
    { name: "80.Priority: High", color: "b60205", description: null },
    { name: "85.Priority: Medium", color: "fbca04", description: null },
    { name: "89.Priority: Low", color: "0e8a16", description: null },
  ],
  assignees: [] as string[],
  isLoading: false,
};
vi.mock("@/hooks/use-issue-repo-meta", () => ({ useIssueRepoMeta: () => repoMeta }));

// 種別の判定結果は指摘ごとに変えず、1件目の呼び出しだけ`30.bug`を返す
const suggestLabels = vi.fn();
const suggest = { generate: suggestLabels, isGenerating: false, error: null, notConfigured: false };
vi.mock("@/hooks/use-issue-suggest", () => ({ useIssueSuggest: () => suggest }));

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
    releaseCheckSince: null,
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
    suggestLabels.mockReset();
    suggestLabels.mockResolvedValue({ kind: "issue", title: "", labels: [] });
  });

  afterEach(cleanup);

  it("軽微も既定で選択する。ボタンは選択中の件数を出す", () => {
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

    expect(screen.getByRole("button", { name: "3件のIssueを作成" })).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "2件のIssueを作成" })).toBeTruthy();
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

    fireEvent.click(screen.getByText("分岐が読みにくい"));
    fireEvent.click(screen.getByRole("button", { name: "2件のIssueを作成" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2));
    expect(createIssue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        repositoryFullName: REPOSITORY_FULL_NAME,
        title: "未完了ジョブの判定が種別を見ていない",
        // 種別が判定できなければ51.improvement、重大は優先度High
        labels: ["51.improvement", "80.Priority: High"],
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

    fireEvent.click(screen.getByText("分岐が読みにくい"));
    fireEvent.click(screen.getByRole("button", { name: "2件のIssueを作成" }));

    await waitFor(() => expect(createIssue).toHaveBeenCalledTimes(2));
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("担当ホストがあり予約をONにすると、作成したIssueをモデル付きで次の5時間枠へ積む", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const onNightlyRunQueued = vi.fn();
    createIssue
      .mockResolvedValueOnce(makeIssue({ id: "1", number: 3001 }))
      .mockResolvedValueOnce(makeIssue({ id: "2", number: 3002 }));

    render(
      <BulkCreateCodeReviewIssuesDialog
        open
        onOpenChange={vi.fn()}
        findings={findings()}
        repositoryFullName={REPOSITORY_FULL_NAME}
        reviewNumber={370}
        onCreated={vi.fn()}
        hosts={[{ name: "subpc", repositories: [REPOSITORY_FULL_NAME] }]}
        onNightlyRunQueued={onNightlyRunQueued}
      />,
    );

    fireEvent.click(screen.getByText("分岐が読みにくい"));
    fireEvent.click(screen.getByRole("checkbox", { name: /次の5時間枠/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Opus/ }));
    fireEvent.click(screen.getByRole("button", { name: "2件を作成して予約" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({
      repository: REPOSITORY_FULL_NAME,
      issue: 3001,
      host: "subpc",
      kind: "next-window",
      model: "opus",
    });
    vi.unstubAllGlobals();
  });

  it("担当ホストが無ければ予約の欄を出さない", () => {
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
    expect(screen.queryByText("作成後に「次の5時間枠」へ予約する")).toBeNull();
  });
});
