// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AskClaudeDialog } from "@/components/dashboard/ask-claude-dialog";
import { Button } from "@/components/ui/button";
import type { Issue } from "@/types/issue";

const commentMutations = {
  createComment: vi.fn(),
  isSubmitting: false,
  error: null,
  setError: vi.fn(),
};

vi.mock("@/hooks/use-issue-comment-mutations", () => ({
  useIssueCommentMutations: () => commentMutations,
}));

function makeIssue(): Issue {
  return {
    repositoryFullName: "guchi-apps/issue-deck",
    number: 1,
    commentCount: 0,
  } as Issue;
}

describe("AskClaudeDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("質問内容の入力欄に「音声入力を整理」ボタンを表示する", async () => {
    render(
      <AskClaudeDialog
        issue={makeIssue()}
        onCommentCreated={() => {}}
        onIssueUpdated={() => {}}
        renderTrigger={() => <Button>Claudeに質問する</Button>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Claudeに質問する" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /音声入力を整理/ })).not.toBeNull(),
    );
  });
});
