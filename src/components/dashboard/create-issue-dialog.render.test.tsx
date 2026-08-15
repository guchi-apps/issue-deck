// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateIssueDialog } from "@/components/dashboard/create-issue-dialog";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

// フックの戻り値は毎レンダー同じ参照を返す（都度 vi.fn() を作ると setError の identity が
// 変わり続け、初期化用のuseEffectが再実行され続けて無限ループになる）
const createIssue = vi.fn();
const updateIssue = vi.fn();
const issueMutations = {
  createIssue,
  updateIssue,
  isSubmitting: false,
  error: null,
  setError: vi.fn(),
};
const commentMutations = {
  createComment: vi.fn(),
  isSubmitting: false,
  error: null,
  setError: vi.fn(),
};
const enqueue = vi.fn();
const dispatchState = {
  hosts: [] as DispatchHostView[],
  jobs: [],
  sessions: [],
  concurrency: 2,
  error: null,
  isSubmitting: false,
  enqueue,
  cancel: vi.fn(),
  setError: vi.fn(),
};

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => issueMutations,
}));

vi.mock("@/hooks/use-issue-comment-mutations", () => ({
  useIssueCommentMutations: () => commentMutations,
}));

vi.mock("@/hooks/use-issue-repo-meta", () => ({
  useIssueRepoMeta: () => ({ labels: [], assignees: [], isLoading: false }),
}));

vi.mock("@/hooks/use-issue-suggest", () => ({
  useIssueSuggest: () => ({
    isGenerating: false,
    error: null,
    notConfigured: false,
    generate: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-progress-status-mutation", () => ({
  useProgressStatusMutation: () => ({ setProgressStatus: vi.fn() }),
}));

vi.mock("@/hooks/use-dispatch-state", () => ({
  useDispatchState: () => dispatchState,
}));

const REPOSITORY_FULL_NAME = "guchi-apps/issue-deck";

function makeRepository(): ConnectedRepository {
  return {
    id: "1",
    name: "issue-deck",
    fullName: REPOSITORY_FULL_NAME,
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    hidden: false,
    favorite: false,
  };
}

function makeHost(): DispatchHostView {
  return {
    name: "subpc",
    repositories: [REPOSITORY_FULL_NAME],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-14T00:00:00Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    maxSessions: 12,
    liveSessions: 0,
    metrics: null,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1434,
    title: "スマホでデバイス選択後、選択画面が再度表示される不具合",
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
    createdAt: "2026-08-14T00:00:00Z",
    updatedAt: "2026-08-14T00:00:00Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    projectStatus: null,
    htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}/issues/1434`,
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

/** 実際の利用と同じく、開閉状態を呼び出し側（issue-deck-shell）が持つ形で描画する */
function Harness({ onCreated }: { onCreated: (issue: Issue) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <CreateIssueDialog
      open={open}
      onOpenChange={setOpen}
      repositories={[makeRepository()]}
      defaultRepositoryFullName={REPOSITORY_FULL_NAME}
      issues={[]}
      onCreated={onCreated}
    />
  );
}

describe("CreateIssueDialog の「作成+実装開始」", () => {
  beforeEach(() => {
    dispatchState.hosts = [makeHost()];
    createIssue.mockResolvedValue(makeIssue());
    enqueue.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    createIssue.mockReset();
    updateIssue.mockReset();
    enqueue.mockReset();
  });

  it("サブPCで開始した後、11.localの付与が返ってきても実行先の選択を開き直さない（#1434）", async () => {
    // `11.local`の付与（GitHubへの往復）は、ダイアログが閉じた後に返る
    let resolveUpdate: ((issue: Issue) => void) | undefined;
    updateIssue.mockReturnValue(
      new Promise<Issue>((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    const onCreated = vi.fn();
    render(<Harness onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "テスト" } });
    fireEvent.click(screen.getByRole("button", { name: "作成+実装開始" }));

    // 作成できた時点で実行先の選択が開く（既定はサブPC）
    await screen.findByText("実装を開始");
    expect(screen.getByRole("radio", { name: /^サブPC/ }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "開始する" }));

    // ジョブを積めた時点で閉じる
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("実装を開始")).toBeNull());

    // 遅れて届いた更新は呼び出し側へ渡すだけで、選択画面は開き直さない
    const updated = makeIssue({ labels: [{ name: LOCAL_LABEL_NAME, color: "e99695" }] as Issue["labels"] });
    resolveUpdate?.(updated);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(updated));
    expect(screen.queryByText("実装を開始")).toBeNull();
  });
});
