// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueDetail } from "@/components/dashboard/issue-detail";
import { MobileIssueDetail } from "@/components/dashboard/mobile/mobile-issue-detail";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import {
  CROSS_REPO_QUESTION_MARKER,
  QA_ANSWER_MARKER,
  QUESTION_COMMENT_MARKER,
} from "@/lib/github/ask-claude";
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
const manualStepPrerequisites = { prerequisites: [], summary: null, dependents: [] };
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
const workflowRun: {
  run: { status: string } | null;
  isLoading: boolean;
  runId: number | null;
  commentId: string | null;
} = { run: null, isLoading: false, runId: null, commentId: null };
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
const dispatchState: {
  hosts: DispatchHostView[];
  jobs: DispatchJobView[];
  sessions: DispatchSessionView[];
  planRequests: unknown[];
  concurrency: number;
  isLoaded: boolean;
  error: string | null;
  isSubmitting: boolean;
  enqueue: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  setError: ReturnType<typeof vi.fn>;
} = {
  hosts: [],
  jobs: [],
  sessions: [],
  planRequests: [],
  concurrency: 2,
  isLoaded: true,
  error: null,
  isSubmitting: false,
  enqueue: vi.fn(),
  cancel: vi.fn(),
  setError: vi.fn(),
};
const pullRequestLinks: [] = [];
const pullRequestsState = { pullRequests: [], isLoadingDetails: false, refresh: vi.fn() };
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
  dispatchRunnable: false,
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
    manualStepVerifiedAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: comments.length,
    ...overrides,
  };
}

function renderDetail(issue: Issue, overrides: Partial<ComponentProps<typeof IssueDetail>> = {}) {
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
      onCreateConfigIssue={vi.fn()}
      onCreateCodeReviewFindingIssue={vi.fn()}
      onStartCodeReview={vi.fn()}
      onSelectRepository={vi.fn()}
      onStartManualStepGuide={vi.fn()}
      {...overrides}
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
      onCreateFollowupIssue={vi.fn()}
      onCreateConfigIssue={vi.fn()}
      onCreateCodeReviewFindingIssue={vi.fn()}
      onStartCodeReview={vi.fn()}
      onSelectRepository={vi.fn()}
      onStartManualStepGuide={vi.fn()}
    />,
  );
}

/** コメント入力欄そのもの。質問Issueではプレースホルダが変わる（#2345） */
function composerTextarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/コメントを追加\.\.\.|続けて質問する場合はここへ\.\.\./) as
    HTMLTextAreaElement;
}

/** コメント入力欄と同じブロックにあるボタンだけを見る（ヘッダーの同名ボタンと区別する） */
function composer(): HTMLElement {
  const block = composerTextarea().closest("div.mt-4");
  if (!block) throw new Error("コメント入力欄のブロックが見つからない");
  return block as HTMLElement;
}

/** ボタンの強さ（`Button`が`data-variant`に出している値）を読む */
function variantOf(name: string): string | null {
  return within(composer()).getByRole("button", { name }).getAttribute("data-variant");
}

/** 入力欄へ下書きを入れる（主ボタンの付け替えは入力の有無で決まる。#2345） */
function typeDraft(text: string): void {
  fireEvent.change(composerTextarea(), { target: { value: text } });
}

afterEach(cleanup);

// デプロイ失敗Issueの案内と出口（#2236）
describe("デプロイ失敗Issueのパネル", () => {
  const META = {
    repositoryFullName: "guchi-apps/issue-deck",
    runId: 482,
    runUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/482",
    version: "4.33.0",
    previousVersion: "4.32.0",
    failedJobs: ["deploy"],
    attempt: 2,
    detectedAt: "2026-08-24T05:00:00.000Z",
  };
  const BODY = `<!-- deploy-failure: ${JSON.stringify(META)} -->\n\n## 何が起きているか`;

  it("PCは、本文のマーカーを読んで出し直しのボタンを出す", () => {
    renderDetail(buildIssue({ body: BODY }));
    expect(screen.getByText("本番デプロイが失敗しています")).toBeTruthy();
    expect(screen.getByRole("button", { name: /本番へ再デプロイ/ })).toBeTruthy();
    expect(screen.getByText(/本番はv4.32.0のままです/)).toBeTruthy();
  });

  it("スマホも同じ（PCと同じ部品を使う）", () => {
    renderMobileDetail(buildIssue({ body: BODY }));
    expect(screen.getByText("本番デプロイが失敗しています")).toBeTruthy();
    expect(screen.getByRole("button", { name: /本番へ再デプロイ/ })).toBeTruthy();
  });

  it("マーカーが無いIssueでは出ない", () => {
    renderDetail(buildIssue({ body: "ふつうの本文" }));
    expect(screen.queryByText("本番デプロイが失敗しています")).toBeNull();
  });
});

describe("IssueDetailのコメント欄の下の操作列（#1770・#2345）", () => {
  it("回答済みの質問Issueでは「回答を確認してクローズ」が出る", () => {
    renderDetail(buildIssue());
    expect(within(composer()).getByRole("button", { name: "回答を確認してクローズ" })).toBeTruthy();
  });

  it("入力が空なら、クローズが主ボタンで「コメント」は枠なしまで沈む", () => {
    renderDetail(buildIssue());
    expect(variantOf("回答を確認してクローズ")).toBe("default");
    expect(variantOf("質問する")).toBe("outline");
    expect(variantOf("コメント")).toBe("ghost");
  });

  it("入力があれば、主ボタンが「質問する」へ移りクローズは枠線へ下がる", () => {
    renderDetail(buildIssue());
    typeDraft("その場合、`11.local`が付いたままだとどうなりますか？");
    expect(variantOf("質問する")).toBe("default");
    expect(variantOf("回答を確認してクローズ")).toBe("outline");
    expect(variantOf("コメント")).toBe("ghost");
  });

  it("空白だけの入力では主ボタンが移らない", () => {
    renderDetail(buildIssue());
    typeDraft("   ");
    expect(variantOf("回答を確認してクローズ")).toBe("default");
    expect(variantOf("質問する")).toBe("outline");
  });

  it("通常のIssueでは出ず、「コメント」が主ボタンのまま", () => {
    renderDetail(buildIssue({ title: "ログイン画面のレイアウトを見直す" }));
    expect(within(composer()).queryByRole("button", { name: "回答を確認してクローズ" })).toBeNull();
    expect(variantOf("コメント")).toBe("default");
    expect(variantOf("質問する")).toBe("outline");
  });

  it("回答待ち（最後が質問コメント）ではクローズが出ず、「質問する」が主ボタンになる", () => {
    commentsState.comments = [comments[0]];
    try {
      renderDetail(buildIssue());
      expect(
        within(composer()).queryByRole("button", { name: "回答を確認してクローズ" }),
      ).toBeNull();
      expect(variantOf("質問する")).toBe("default");
      expect(variantOf("コメント")).toBe("ghost");
    } finally {
      commentsState.comments = comments;
    }
  });

  /**
   * 横断質問Issue（#1454）は`[質問] `タイトルを持つが、記録先にコメントを拾う無人実行が無い。
   * 「質問する」を主ボタンにすると、押した人が回答も出口も失う（#2345）。
   */
  it("横断質問Issueでは、入力があっても主ボタンが「質問する」へ移らない", () => {
    commentsState.comments = [
      { ...comments[0], body: `横断の質問\n\n${QUESTION_COMMENT_MARKER}\n${CROSS_REPO_QUESTION_MARKER}` },
      comments[1],
    ];
    try {
      renderDetail(buildIssue());
      typeDraft("続きの質問です");
      expect(variantOf("回答を確認してクローズ")).toBe("default");
      expect(variantOf("質問する")).toBe("outline");
      expect(composerTextarea().placeholder).toBe("コメントを追加...");
    } finally {
      commentsState.comments = comments;
    }
  });

  it("質問Issueでは入力欄のプレースホルダが「続けて質問する場合はここへ...」になる", () => {
    renderDetail(buildIssue());
    expect(composerTextarea().placeholder).toBe("続けて質問する場合はここへ...");
    cleanup();
    renderDetail(buildIssue({ title: "ログイン画面のレイアウトを見直す" }));
    expect(composerTextarea().placeholder).toBe("コメントを追加...");
  });
});

/**
 * `Ctrl`+`Enter`は、そのとき主ボタンになっている投稿操作へ届かせる（#2345）。
 * **クローズには割り当てない**ので、クローズが主のときはコメントとして投稿される。
 */
describe("IssueDetailのコメント欄のCtrl+Enter（#2345）", () => {
  afterEach(() => commentMutations.createComment.mockReset());

  function pressCtrlEnter(): void {
    fireEvent.keyDown(composerTextarea(), { key: "Enter", ctrlKey: true });
  }

  it("質問Issueで入力があるときは、質問コメントとして投稿する", () => {
    renderDetail(buildIssue());
    typeDraft("続きの質問です");
    pressCtrlEnter();
    const body = commentMutations.createComment.mock.calls[0][0].body as string;
    expect(body).toContain(QUESTION_COMMENT_MARKER);
    expect(body).toContain("続きの質問です");
  });

  it("通常のIssueでは、ふつうのコメントとして投稿する", () => {
    renderDetail(buildIssue({ title: "ログイン画面のレイアウトを見直す" }));
    typeDraft("ふつうのコメント");
    pressCtrlEnter();
    const body = commentMutations.createComment.mock.calls[0][0].body as string;
    expect(body).toBe("ふつうのコメント");
    expect(body).not.toContain(QUESTION_COMMENT_MARKER);
  });

  it("PCとスマホで宛先が揃う", () => {
    renderMobileDetail(buildIssue());
    typeDraft("スマホから続きの質問です");
    pressCtrlEnter();
    const body = commentMutations.createComment.mock.calls[0][0].body as string;
    expect(body).toContain(QUESTION_COMMENT_MARKER);
  });
});

/**
 * スマホの詳細にも同じ出口を置く（#1770）。こちらは同じ操作が⋯メニューの奥にしかなく、
 * 開き直さないと終えられなかった
 */
describe("MobileIssueDetailのコメント欄の下の操作列（#1770・#2345）", () => {
  it("入力が空なら、クローズが主ボタンで「コメント」は枠なしまで沈む", () => {
    renderMobileDetail(buildIssue());
    expect(variantOf("回答を確認してクローズ")).toBe("default");
    expect(variantOf("コメント")).toBe("ghost");
  });

  it("入力があれば、主ボタンが「質問する」へ移る（PCと同じ）", () => {
    renderMobileDetail(buildIssue());
    typeDraft("続きの質問です");
    expect(variantOf("質問する")).toBe("default");
    expect(variantOf("回答を確認してクローズ")).toBe("outline");
  });

  it("通常のIssueでは出ない", () => {
    renderMobileDetail(buildIssue({ title: "ログイン画面のレイアウトを見直す" }));
    expect(within(composer()).queryByRole("button", { name: "回答を確認してクローズ" })).toBeNull();
  });
});

/**
 * 実行を開始した直後は、進捗（Project Status）もジョブもセッションもまだ画面へ届かない（#1815）。
 *
 * 届いているのは**積むより先に付けている`11.local`だけ**なので、これを見ずに開始ボタンを
 * 出し続けると、押した後もまったく同じ主ボタンが残り、効かなかったように見える。
 */
describe("実行を開始したIssueの開始ボタン（#1815）", () => {
  const localLabel = [{ name: "11.local", color: "d73a4a", description: null }];

  it("PCは、`11.local`が付いていれば開始ボタンを出さない", () => {
    renderDetail(buildIssue({ title: "ログイン画面のレイアウトを見直す", labels: localLabel }));
    expect(screen.queryByRole("button", { name: /で開始$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "実装を開始" })).toBeNull();
  });

  it("PCは、`11.local`が無ければ従来どおり開始ボタンを出す", () => {
    renderDetail(buildIssue({ title: "ログイン画面のレイアウトを見直す" }));
    expect(screen.getByRole("button", { name: /GitHub Actionsで開始/ })).toBeTruthy();
  });

  it("スマホも同じ（`11.local`が付いていれば出さない）", () => {
    renderMobileDetail(
      buildIssue({ title: "ログイン画面のレイアウトを見直す", labels: localLabel }),
    );
    expect(screen.queryByRole("button", { name: /で開始$/ })).toBeNull();
  });

  it("スマホも、`11.local`が無ければ従来どおり出す", () => {
    renderMobileDetail(buildIssue({ title: "ログイン画面のレイアウトを見直す" }));
    expect(screen.getByRole("button", { name: /GitHub Actionsで開始/ })).toBeTruthy();
  });

  /** ボタンを消したぶん、何が起きているのかは`IssueStatusCard`が1行で出す */
  it("開始ボタンの代わりに「ローカルで対応中」が出る", () => {
    renderMobileDetail(
      buildIssue({ title: "ログイン画面のレイアウトを見直す", labels: localLabel }),
    );
    expect(screen.getByText("ローカルで対応中")).toBeTruthy();
  });
});

/**
 * GitHub Actionsで実装が走っている最中も、サブPCの起動ボタンだけは残っていた（#2032）。
 *
 * 進捗が`Implementation`へ進むため「実装を開始」ダイアログは消えるが、そこが消えると
 * `StartLocalSessionButton`の起動ボタンが出る（落ちたセッションを立て直すための導線・#1349）。
 * ジョブもセッションもまだ無く、停止フラグ（`11.local`）はActions側が判定を終えた後では
 * 効かないので、押すと同じ`issue-<番号>`ブランチをActionsとサブPCが別々に進める。
 */
describe("GitHub Actionsが走っているIssueの起動ボタン（#2032）", () => {
  /** 起動先が1台だけなら、ボタンの文言はそのホスト名になる（`StartLocalSessionButton`） */
  const subpc = {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-20T00:00:00.000Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: true,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    codexCapable: null,
    codexRemoteControlCapable: null,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: null,
    reboot: null,
    previewRepositories: null,
    preview: null,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
    launchHold: null,
    checkout: null,
  };

  /** Actionsが実装中のIssue。`Implementation`なので「実装を開始」ダイアログは出ない */
  function runningIssue() {
    return buildIssue({
      title: "ログイン画面のレイアウトを見直す",
      projectStatus: "Implementation",
    });
  }

  function withState(run: { status: string } | null, body: () => void) {
    dispatchState.hosts = [subpc];
    workflowRun.run = run;
    try {
      body();
    } finally {
      dispatchState.hosts = [];
      workflowRun.run = null;
    }
  }

  it("PCは、Actionsの実行中なら起動ボタンを出さない", () => {
    withState({ status: "in_progress" }, () => {
      renderDetail(runningIssue());
      expect(screen.queryByRole("button", { name: /で開始$/ })).toBeNull();
    });
  });

  it("PCは、Actionsの実行が終わっていれば従来どおり出す（立て直しの導線を塞がない）", () => {
    withState({ status: "completed" }, () => {
      renderDetail(runningIssue());
      expect(screen.getByRole("button", { name: "サブPCで開始" })).toBeTruthy();
    });
  });

  it("スマホも同じ（実行中なら出さない）", () => {
    withState({ status: "queued" }, () => {
      renderMobileDetail(runningIssue());
      expect(screen.queryByRole("button", { name: /で開始$/ })).toBeNull();
    });
  });

  it("スマホも、実行が終わっていれば従来どおり出す", () => {
    withState({ status: "completed" }, () => {
      renderMobileDetail(runningIssue());
      expect(screen.getByRole("button", { name: "サブPCで開始" })).toBeTruthy();
    });
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

/**
 * 確認待ちの案内は、セッションの状態（`/api/dispatch`）が届いてから出す（#1810）。
 *
 * 取得前の`sessions`は`[]`で、ローカルセッションが入力待ちかどうかは分からない。それを
 * 「入力待ちではない」と読むと、Remote Controlの案内を出すべき場面で承認欄への案内を
 * 先に出してしまう（実際、サブPCで走っているIssueを開くと一瞬だけそちらが見えていた）。
 */
describe("確認待ちの案内が出るタイミング（#1810）", () => {
  const waitingSession = {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1810",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    issueTitle: null,
    issueId: null,
    state: "ALIVE" as const,
    exitStatus: null,
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastReportedAt: "2026-08-01T00:10:00.000Z",
    activity: "WAITING_INPUT" as const,
    activityAt: "2026-08-01T00:10:00.000Z",
    remoteControlUrl: "https://claude.ai/code/session_abc",
    previewUrl: null,
    codexThreadKnown: null,
    step: null,
    stepAt: null,
    stepSeenAt: null,
  };

  const checkUserIssue = () =>
    buildIssue({
      title: "サブPCで実装中のIssue",
      labels: ["00.check-user", "01.check-input", "11.local"].map((name) => ({
        name,
        color: "d73a4a",
        description: null,
      })),
    });

  function withSessions<T>(sessions: unknown[], isLoaded: boolean, run: () => T): T {
    const prev = { sessions: dispatchState.sessions, isLoaded: dispatchState.isLoaded };
    Object.assign(dispatchState, { sessions, isLoaded });
    try {
      return run();
    } finally {
      Object.assign(dispatchState, prev);
    }
  }

  it("PCは、届くまで承認欄への案内を出さない", () => {
    withSessions([], false, () => {
      renderDetail(checkUserIssue());
      expect(screen.queryByText("質問への回答が必要です")).toBeNull();
      expect(screen.queryByRole("button", { name: /承認欄へ移動/ })).toBeNull();
    });
  });

  /** 案内パネル（`CheckUserReasonNotice`）の中だけを見る（コメント欄の案内にも同名のリンクがある） */
  function guidancePanel(): HTMLElement {
    // 見出しは`<p>`の中の`<span>`（#2057で「待機中」タグを同じ行へ寄せた）。
    // パネルはその外側のdivなので、階層の数ではなく`closest`で辿る
    const panel = screen.getByText("質問への回答が必要です").closest("div");
    if (!panel) throw new Error("確認待ちの案内が見つからない");
    return panel;
  }

  /**
   * 計画への返事待ち（#2061）。**セッション表示のすぐ下**に出るので、待っている間は
   * ここが唯一の答える場所になる（切れると従来どおり端末の承認プロンプトへ戻る）。
   */
  it("PCは、計画の返事待ちがあれば承認パネルを出す", () => {
    const prev = dispatchState.planRequests;
    dispatchState.planRequests = [
      {
        id: "req-1",
        repositoryFullName: repository.fullName,
        issueNumber: 1,
        hostName: "subpc",
        plan: "## 要約\n\n**計画の承認パネルをIssue詳細に出す**",
        status: "WAITING",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 27 * 60_000).toISOString(),
        decidedAt: null,
        delivered: false,
      },
    ];
    try {
      withSessions([waitingSession], true, () => {
        renderDetail(checkUserIssue());
        expect(screen.getByText("計画の承認を待っています")).toBeTruthy();
        expect(screen.getByRole("button", { name: /承認して実装へ進む/ })).toBeTruthy();
      });
    } finally {
      dispatchState.planRequests = prev;
    }
  });

  /**
   * #2057。案内パネルの見出しが同じ用件を書いているので、その1行上のバッジは重複になる。
   * 確認待ちであること自体は現在ステップの琥珀色で読める。
   */
  it("案内パネルが出ているとき、ステッパーの確認待ちバッジは出さない（#2057）", () => {
    withSessions([waitingSession], true, () => {
      renderDetail(checkUserIssue());
      expect(screen.getByText("質問への回答が必要です")).toBeTruthy();
      expect(screen.queryByText(/^ユーザー確認待ち/)).toBeNull();
    });
  });

  it("PCは、届いた時点でRemote Controlの案内を出す", () => {
    withSessions([waitingSession], true, () => {
      renderDetail(checkUserIssue());
      expect(within(guidancePanel()).getByRole("link", { name: /Remote Controlで開く/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /承認欄へ移動/ })).toBeNull();
    });
  });

  it("スマホも同じ（届くまで出さず、届いたらRemote Controlへ寄せる）", () => {
    withSessions([], false, () => {
      renderMobileDetail(checkUserIssue());
      expect(screen.queryByText("質問への回答が必要です")).toBeNull();
    });
    cleanup();
    withSessions([waitingSession], true, () => {
      renderMobileDetail(checkUserIssue());
      expect(within(guidancePanel()).getByRole("link", { name: /Remote Controlで開く/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /承認欄へ移動/ })).toBeNull();
    });
  });
});

/**
 * 質問の導線をコメント欄の下の「質問する」へ一本化した（#1913）。ヘッダーの
 * 「Claudeに質問する」は投稿されるコメントが同一で、押した結果が変わらなかった
 */
describe("質問の導線（#1913）", () => {
  it("ヘッダーに「Claudeに質問する」は出ない", () => {
    renderDetail(buildIssue());
    expect(screen.queryByRole("button", { name: "Claudeに質問する" })).toBeNull();
  });

  it("コメント欄の下の「質問する」は残る", () => {
    renderDetail(buildIssue());
    expect(within(composer()).getByRole("button", { name: "質問する" })).toBeTruthy();
  });

  it("スマホも同じ（⋯メニューから消し、コメント欄の下だけに残す）", () => {
    renderMobileDetail(buildIssue());
    expect(screen.queryByText("Claudeに質問する")).toBeNull();
    expect(within(composer()).getByRole("button", { name: "質問する" })).toBeTruthy();
  });
});

/**
 * 「いまは実施しない」の選択肢（#2398）を⋯メニューから開いたときの振る舞い（#2458）。
 *
 * Radixのメニューは**マウスが乗った項目へフォーカスを移す**ため、選択肢を出したあとに
 * マウスを動かすとポップオーバー側が「フォーカスが外れた」と見なして勝手に閉じ、
 * パソコンからは何も選べなくなっていた。
 */
describe("⋯メニューの「いまは実施しない」（#2458）", () => {
  /** Radixのメニューはポインタ関連のAPIを触るため、jsdomに無いものだけ足す */
  function stubPointerApis() {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  /** ⋯メニューを開いて「いまは実施しない」まで進む（Radixのメニューはpointerdownで開く） */
  function openSnoozeMenu(onSnooze = vi.fn()) {
    stubPointerApis();
    renderDetail(buildIssue(), { snoozes: new Map(), onSnooze, onUnsnooze: vi.fn() });
    fireEvent.pointerDown(screen.getByRole("button", { name: "操作メニュー" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "いまは実施しない" }));
    return onSnooze;
  }

  /** メニューの別の項目の上へマウスを動かす（Radixはここで項目へフォーカスを移す） */
  function movePointerToItem(name: string) {
    fireEvent.pointerMove(screen.getByRole("menuitem", { name }), { pointerType: "mouse" });
  }

  it("開いた選択肢はマウスを動かしても閉じない", () => {
    openSnoozeMenu();
    expect(screen.getByRole("button", { name: /明日まで/ })).toBeTruthy();
    movePointerToItem("編集");
    expect(screen.getByRole("button", { name: /明日まで/ })).toBeTruthy();
  });

  it("マウスを動かしたあとでも選択肢を押せる", () => {
    const onSnooze = openSnoozeMenu();
    movePointerToItem("編集");
    fireEvent.click(screen.getByRole("button", { name: /明日まで/ }));
    expect(onSnooze).toHaveBeenCalledTimes(1);
    expect(onSnooze.mock.calls[0][0]).toEqual({
      kind: "issue",
      repositoryFullName: "guchi-apps/issue-deck",
      number: 1,
    });
  });

  it("選んだら⋯メニューごと閉じる", () => {
    openSnoozeMenu();
    fireEvent.click(screen.getByRole("button", { name: /明日まで/ }));
    expect(screen.queryByRole("menuitem", { name: "編集" })).toBeNull();
  });
});
