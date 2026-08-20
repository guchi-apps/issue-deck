// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssuePropertiesPanel } from "@/components/dashboard/issue-properties-panel";
import type { Issue } from "@/types/issue";

vi.mock("@/hooks/use-issue-repo-meta", () => ({
  useIssueRepoMeta: () => ({ labels: [], assignees: [], isLoading: false }),
}));

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => ({
    updateIssue: vi.fn(),
    isSubmitting: false,
  }),
}));

vi.mock("@/hooks/use-progress-status-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-progress-status-mutation")>()),
  useProgressStatusMutation: () => ({ setProgressStatus: vi.fn() }),
}));

function buildIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1350,
    title: "Issue詳細画面にステータス表示・変更機能を追加",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "guchi" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1350",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

describe("IssuePropertiesPanel の進捗", () => {
  afterEach(() => {
    cleanup();
  });

  it("現在のProject Statusを日本語で表示する", () => {
    render(
      <IssuePropertiesPanel
        issue={buildIssue({ projectStatus: "Implementation" })}
        repositories={[]}
        onIssueUpdated={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "進捗" }).textContent).toContain("実装中");
  });

  it("Projectへ未登録のIssueは「未着手」ではなく「未設定」と出す", () => {
    render(
      <IssuePropertiesPanel
        issue={buildIssue({ projectStatus: null })}
        repositories={[]}
        onIssueUpdated={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "進捗" });
    expect(trigger.textContent).toContain("未設定");
    expect(trigger.textContent).not.toContain("未着手");
  });

  it("変更しても実行は始まらないことを画面に明記する", () => {
    render(
      <IssuePropertiesPanel
        issue={buildIssue({ projectStatus: "Ready" })}
        repositories={[]}
        onIssueUpdated={vi.fn()}
      />,
    );

    expect(screen.getByText(/実行は開始しません/)).toBeDefined();
  });
});
