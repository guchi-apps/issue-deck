// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditIssueDialog } from "@/components/dashboard/edit-issue-dialog";
import type { Issue } from "@/types/issue";

// フックの戻り値は毎レンダー同じ参照を返す（create-issue-dialog.render.test.tsxと同じ理由。
// 都度 vi.fn() を作ると初期化用のuseEffectが再実行され続ける）
const updateIssue = vi.fn();
const issueMutations = {
  createIssue: vi.fn(),
  updateIssue,
  isSubmitting: false,
  error: null as string | null,
  setError: vi.fn(),
};

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => issueMutations,
}));

const suggestGenerate = vi.fn();
const suggestState = {
  isGenerating: false,
  error: null as string | null,
  notConfigured: false,
  generate: suggestGenerate,
};

vi.mock("@/hooks/use-issue-suggest", () => ({
  useIssueSuggest: () => suggestState,
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1577,
    title: "元のタイトル",
    body: "元の本文",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "m-guchi", avatarUrl: "" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-15T12:00:00.000Z",
    updatedAt: "2026-08-15T12:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1577",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  issueMutations.isSubmitting = false;
  issueMutations.error = null;
  suggestState.isGenerating = false;
  suggestState.error = null;
  suggestState.notConfigured = false;
});

describe("EditIssueDialog", () => {
  it("タイトル欄の横に「付け直す」を出す", () => {
    render(
      <EditIssueDialog
        open
        onOpenChange={vi.fn()}
        issue={makeIssue()}
        issues={[]}
        onUpdated={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "付け直す" })).not.toBeNull();
  });

  it("押すと本文からタイトル案を生成し、タイトル欄へ反映する", async () => {
    suggestGenerate.mockResolvedValue({ kind: "issue", title: "生成されたタイトル", labels: [] });

    render(
      <EditIssueDialog
        open
        onOpenChange={vi.fn()}
        issue={makeIssue()}
        issues={[]}
        onUpdated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "付け直す" }));

    await waitFor(() => {
      // ラベルは使わないので空で呼ぶ（Jevを選んでいても判定を呼ばせない。#3245）
      expect(suggestGenerate).toHaveBeenCalledWith("元の本文", []);
      expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe(
        "生成されたタイトル",
      );
    });
  });

  it("本文が空だと押せない", () => {
    render(
      <EditIssueDialog
        open
        onOpenChange={vi.fn()}
        issue={makeIssue({ body: "" })}
        issues={[]}
        onUpdated={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: "付け直す" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("生成中は「付け直す」と「保存」を無効化する", () => {
    suggestState.isGenerating = true;

    render(
      <EditIssueDialog
        open
        onOpenChange={vi.fn()}
        issue={makeIssue()}
        issues={[]}
        onUpdated={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: "付け直す" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("提案APIが未設定エラーを返したら案内文を出す", () => {
    suggestState.notConfigured = true;

    render(
      <EditIssueDialog
        open
        onOpenChange={vi.fn()}
        issue={makeIssue()}
        issues={[]}
        onUpdated={vi.fn()}
      />,
    );

    expect(
      screen.getByText("選択したAIモデルの認証情報が設定されていないため、自動では決められません。自分で入力してください。"),
    ).not.toBeNull();
  });
});
