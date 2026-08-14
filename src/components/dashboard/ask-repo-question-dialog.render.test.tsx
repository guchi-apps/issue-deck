// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AskRepoQuestionDialog } from "@/components/dashboard/ask-repo-question-dialog";
import type { ConnectedRepository } from "@/types/repository";

// フックの戻り値は毎レンダー同じ参照を返す（都度 vi.fn() を作ると setError の identity が
// 変わり続け、初期化用のuseEffectが再実行され続けて無限ループになる）
const issueMutations = {
  createIssue: vi.fn(),
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

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => issueMutations,
}));

vi.mock("@/hooks/use-issue-comment-mutations", () => ({
  useIssueCommentMutations: () => commentMutations,
}));

vi.mock("@/hooks/use-issue-repo-meta", () => ({
  useIssueRepoMeta: () => ({ labels: [], assignees: [], isLoading: false }),
}));

function makeRepository(): ConnectedRepository {
  return {
    id: "1",
    name: "issue-deck",
    fullName: "guchi-apps/issue-deck",
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    hidden: false,
    favorite: false,
  };
}

describe("AskRepoQuestionDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("質問内容の入力欄に「音声入力を整理」ボタンを表示する", () => {
    render(
      <AskRepoQuestionDialog
        open
        onOpenChange={() => {}}
        repositories={[makeRepository()]}
        onCreated={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /音声入力を整理/ })).not.toBeNull();
  });
});
