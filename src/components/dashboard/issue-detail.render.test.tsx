// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueDetail } from "@/components/dashboard/issue-detail";
import { MobileIssueDetail } from "@/components/dashboard/mobile/mobile-issue-detail";
import { QA_ANSWER_MARKER, QUESTION_COMMENT_MARKER } from "@/lib/github/ask-claude";
import type { Issue, IssueComment } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

/**
 * 質問Issueの出口（#1770）が、コメント欄の下に出ることを確かめる。
 *
 * 表示条件そのもの（`canCloseAskRepoQuestion`）は`lib/github/ask-claude.test.ts`が見ているので、
 * ここでは**画面のどこに出るか**と**主ボタンがどれか**だけを見る。フックの戻り値は毎レンダー
 * 同じ参照を返す（都度作ると依存配列が変わり続けて再レンダーが止まらない）。
 */
const comments: IssueComment[] = [
  {
    id: "comment-1",
    author: { login: "guchi" },
    createdAtLabel: "2026/08/01 09:00",
    body: `@claude 質問: ラベルはどこで付いていますか？\n\n${QUESTION_COMMENT_MARKER}`,
    reactionCount: 0,
  },
  {
    id: "comment-2",
    author: { login: "github-actions[bot]" },
    createdAtLabel: "2026/08/01 09:10",
    body: `issue-labels.ymlが付けています。\n\n${QA_ANSWER_MARKER}`,
    reactionCount: 0,
  },
];

const commentsState = { comments, isLoading: false, error: null, setComments: vi.fn() };
const subIssues = { relations: { parent: null, children: [] }, isLoading: false };
const manualStepPrerequisites = { prerequisites: [], summary: null };
const taskList = {
  body: "本文",
  progress: { completed: 0, total: 0 },
  isToggling: false,
  error: null,
  toggleTask: vi.fn(),
};
const commentSummaries = {
  summaries: {},
  generatingIds: new Set<number>(),
  errors: {},
  notConfigured: false,
  generate: vi.fn(),
};
const workflowRun = { run: null, isLoading: false, runId: null, commentId: null };
const issueMutations = {
  updateIssue: vi.fn(),
  deleteIssue: vi.fn(),
  isSubmitting: false,
  error: null,
  setError: vi.fn(),
};
const commentMutations = {
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  isSubmitting: false,
  error: null,
  setError: vi.fn(),
};
const dispatchState = {
  hosts: [],
  jobs: [],
  sessions: [],
  concurrency: 2,
  isLoaded: true,
  error: null,
  isSubmitting: false,
  enqueue: vi.fn(),
  cancel: vi.fn(),
  setError: vi.fn(),
};
const pullRequestLinks: [] = [];
const pullRequestsState = { pullRequests: [], refresh: vi.fn() };
const mergeMutation = {
  mergePullRequest: vi.fn(),
  isSubmitting: false,
  error: null,
  setError: vi.fn(),
};

vi.mock("@/hooks/use-issue-comments", () => ({ useIssueComments: () => commentsState }));
vi.mock("@/hooks/use-issue-sub-issues", () => ({ useIssueSubIssues: () => subIssues }));
vi.mock("@/hooks/use-manual-step-prerequisites", () => ({
  useManualStepPrerequisites: () => manualStepPrerequisites,
}));
vi.mock("@/hooks/use-issue-task-list", () => ({ useIssueTaskList: () => taskList }));
vi.mock("@/hooks/use-issue-comment-summaries", () => ({
  useIssueCommentSummaries: () => commentSummaries,
}));
vi.mock("@/hooks/use-first-unread-comment-index", () => ({
  useFirstUnreadCommentIndex: () => ({ index: null, hasUnread: false }),
}));
vi.mock("@/hooks/use-issue-workflow-run", () => ({ useIssueWorkflowRun: () => workflowRun }));
vi.mock("@/hooks/use-issue-mutations", () => ({ useIssueMutations: () => issueMutations }));
vi.mock("@/hooks/use-issue-comment-mutations", () => ({
  useIssueCommentMutations: () => commentMutations,
}));
vi.mock("@/hooks/use-dispatch-state", () => ({ useDispatchState: () => dispatchState }));
vi.mock("@/hooks/use-pull-request-link", () => ({ usePullRequestLinks: () => pullRequestLinks }));
vi.mock("@/hooks/use-issue-pull-requests", () => ({
  useIssuePullRequests: () => pullRequestsState,
}));
vi.mock("@/hooks/use-pull-request-merge-mutation", () => ({
  usePullRequestMergeMutation: () => mergeMutation,
}));

// 中身の描画はこのテストの対象外。自前でfetchするものだけ差し替える
vi.mock("@/components/dashboard/comment-thread", () => ({
  CommentThread: () => <div data-testid="comment-thread" />,
}));
vi.mock("@/components/dashboard/issue-ai-summary", () => ({
  IssueAiSummarySection: () => null,
}));
vi.mock("@/components/dashboard/issue-session-status", () => ({
  IssueSessionStatus: () => null,
  summarizeIssueSession: () => ({ remoteControlUrl: null }),
}));

const repository: ConnectedRepository = {
  id: "repo-1",
  name: "issue-deck",
  fullName: "guchi-apps/issue-deck",
  private: false,
  archived: false,
  hasClaudeWorkflow: true,
  hasLocalStartScript: true,
  hidden: false,
  favorite: false,
};

function buildIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    number: 1,
    title: "[質問] ラベルはどこで付いていますか？",
    body: "本文",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "guchi" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: comments.length,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: comments.length,
    ...overrides,
  };
}

function renderDetail(issue: Issue) {
  return render(
    <IssueDetail
      issue={issue}
      issues={[issue]}
      repositories={[repository]}
      currentUserLogin="guchi"
      onEdit={vi.fn()}
      onIssueUpdated={vi.fn()}
      onIssueDeleted={vi.fn()}
      onToggleFavorite={vi.fn()}
      onCreateFollowupIssue={vi.fn()}
      onSelectRepository={vi.fn()}
    />,
  );
}

function renderMobileDetail(issue: Issue) {
  return render(
    <MobileIssueDetail
      issue={issue}
      issues={[issue]}
      repositories={[repository]}
      currentUserLogin="guchi"
      onBack={vi.fn()}
      onEdit={vi.fn()}
      onIssueUpdated={vi.fn()}
      onIssueDeleted={vi.fn()}
      onToggleFavorite={vi.fn()}
      onCreateIssue={vi.fn()}
      onCreateFollowupIssue={vi.fn()}
      onSelectRepository={vi.fn()}
    />,
  );
}

/** コメント入力欄と同じブロックにあるボタンだけを見る（ヘッダーの同名ボタンと区別する） */
function composer(): HTMLElement {
  const textarea = screen.getByPlaceholderText("コメントを追加...");
  const block = textarea.closest("div.mt-4");
  if (!block) throw new Error("コメント入力欄のブロックが見つからない");
  return block as HTMLElement;
}

afterEach(cleanup);

describe("IssueDetailのコメント欄の下の操作列（#1770）", () => {
  it("回答済みの質問Issueでは「回答を確認してクローズ」が出る", () => {
    renderDetail(buildIssue());
    expect(within(composer()).getByRole("button", { name: "回答を確認してクローズ" })).toBeTruthy();
  });

  it("質問Issueでは主ボタン（塗りつぶし）がクローズで、「コメント」は枠線になる", () => {
    renderDetail(buildIssue());
    const close = within(composer()).getByRole("button", { name: "回答を確認してクローズ" });
    const comment = within(composer()).getByRole("button", { name: "コメント" });
    expect(close.className).toContain("bg-primary");
    expect(comment.className).toContain("bg-background");
    expect(comment.className).not.toContain("bg-primary");
  });

  it("通常のIssueでは出ず、「コメント」が主ボタンのまま", () => {
    renderDetail(buildIssue({ title: "ログイン画面のレイアウトを見直す" }));
    expect(within(composer()).queryByRole("button", { name: "回答を確認してクローズ" })).toBeNull();
    expect(
      within(composer()).getByRole("button", { name: "コメント" }).className,
    ).toContain("bg-primary");
  });

  it("回答待ち（最後が質問コメント）では出ない", () => {
    commentsState.comments = [comments[0]];
    try {
      renderDetail(buildIssue());
      expect(
        within(composer()).queryByRole("button", { name: "回答を確認してクローズ" }),
      ).toBeNull();
    } finally {
      commentsState.comments = comments;
    }
  });
});

/**
 * スマホの詳細にも同じ出口を置く（#1770）。こちらは同じ操作が⋯メニューの奥にしかなく、
 * 開き直さないと終えられなかった
 */
describe("MobileIssueDetailのコメント欄の下の操作列（#1770）", () => {
  it("回答済みの質問Issueでは「回答を確認してクローズ」が主ボタンとして出る", () => {
    renderMobileDetail(buildIssue());
    const close = within(composer()).getByRole("button", { name: "回答を確認してクローズ" });
    expect(close.className).toContain("bg-primary");
    expect(within(composer()).getByRole("button", { name: "コメント" }).className).toContain(
      "bg-background",
    );
  });

  it("通常のIssueでは出ない", () => {
    renderMobileDetail(buildIssue({ title: "ログイン画面のレイアウトを見直す" }));
    expect(within(composer()).queryByRole("button", { name: "回答を確認してクローズ" })).toBeNull();
  });
});

/**
 * 「コメント欄へ移動」ボタン（ScrollToLatestCommentButton）は画面下端から`bottom-4`で
 * 浮いているため、スクロール領域の中身の下端にそのぶんの余白が無いと、最下部まで
 * スクロールしたときコメント入力欄の操作列へ重なる（#1793）。
 *
 * jsdomでは実寸を測れないので、`mobile-screen-scroll-container.test.ts`（#1664）と同じく
 * クラスの有無で規約を固定する。
 */
describe("Issue詳細の下端の余白（#1793）", () => {
  /** スクロール領域の目印は撮影用の`data-capture-scroll-bottom`を借りる */
  function scrollContainer(): HTMLElement {
    const container = document.querySelector("[data-capture-scroll-bottom]");
    if (!container) throw new Error("スクロール領域が見つからない");
    return container as HTMLElement;
  }

  it("PCは中身のラッパにpb-16がある", () => {
    renderDetail(buildIssue());
    // 中身のラッパはヘッダーの次＝スクロール領域の最後の子
    const content = scrollContainer().lastElementChild;
    expect(content?.className).toContain("pb-16");
  });

  it("スマホはスクロール領域にpb-20がある", () => {
    renderMobileDetail(buildIssue());
    expect(scrollContainer().className).toContain("pb-20");
  });
});
