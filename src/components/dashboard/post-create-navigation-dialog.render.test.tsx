// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostCreateNavigationDialog } from "@/components/dashboard/post-create-navigation-dialog";
import type { Issue } from "@/types/issue";

const REPOSITORY_FULL_NAME = "guchi-apps/issue-deck";

function makeIssue(): Issue {
  return {
    id: "1",
    number: 2863,
    title: "Issue作成後の画面遷移を選択できるようにする",
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
    htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}/issues/2863`,
    favorite: false,
    excludedFromIssueCreation: false,
    releaseCheckSince: null,
    hasUnreadComments: false,
    readCommentCount: 0,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
  } as Issue;
}

describe("PostCreateNavigationDialog（#2862）", () => {
  afterEach(cleanup);

  it("作れたIssueのリポジトリ・番号・タイトルを出す", () => {
    render(
      <PostCreateNavigationDialog issue={makeIssue()} onSelect={() => {}} onDismiss={() => {}} />,
    );

    expect(screen.getByText("issue-deck")).not.toBeNull();
    expect(screen.getByText("#2863")).not.toBeNull();
    expect(screen.getByText("Issue作成後の画面遷移を選択できるようにする")).not.toBeNull();
  });

  it("タイルを押した時点で行き先が決まる（決定ボタンを挟まない）", () => {
    const onSelect = vi.fn();
    render(
      <PostCreateNavigationDialog issue={makeIssue()} onSelect={onSelect} onDismiss={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Issueを開く/ }));
    expect(onSelect).toHaveBeenCalledWith("detail", false);
  });

  it("「元の画面に戻る」も同じ形で渡す", () => {
    const onSelect = vi.fn();
    render(
      <PostCreateNavigationDialog issue={makeIssue()} onSelect={onSelect} onDismiss={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /元の画面に戻る/ }));
    expect(onSelect).toHaveBeenCalledWith("stay", false);
  });

  /** #2932。まとめて起票するときに、一覧へ戻ってリポジトリを選び直す往復をなくす */
  it("「続けて作成」も同じ形で渡す", () => {
    const onSelect = vi.fn();
    render(
      <PostCreateNavigationDialog issue={makeIssue()} onSelect={onSelect} onDismiss={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /続けて作成/ }));
    expect(onSelect).toHaveBeenCalledWith("another", false);
  });

  it("「次回からこの画面を出さない」を入れてから押すと、記憶する指示も一緒に渡す", () => {
    const onSelect = vi.fn();
    render(
      <PostCreateNavigationDialog issue={makeIssue()} onSelect={onSelect} onDismiss={() => {}} />,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /元の画面に戻る/ }));
    expect(onSelect).toHaveBeenCalledWith("stay", true);
  });

  /** ×・Escapeは「まだ決めていない」であって、行き先を選んだことにはしない */
  it("選ばずに閉じたときは記憶も遷移もしない", () => {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    render(
      <PostCreateNavigationDialog issue={makeIssue()} onSelect={onSelect} onDismiss={onDismiss} />,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onDismiss).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
