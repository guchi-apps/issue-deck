// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MobileIssuePropertiesSection } from "@/components/dashboard/mobile/mobile-issue-properties-section";
import type { Issue } from "@/types/issue";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    number: 1920,
    title: "スマートフォンの画面でステータスを変更できるようにする",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "m-guchi" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1920",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function renderSection(overrides: Partial<Issue> = {}) {
  render(
    <MobileIssuePropertiesSection
      issue={issue(overrides)}
      isSubmitting={false}
      onToggleLabel={vi.fn()}
      onAssigneeChange={vi.fn()}
      onIssueUpdated={vi.fn()}
    />,
  );
}

/** 折りたたみを開く（既定は畳まれており、中身はDOMに無い） */
function openSection() {
  fireEvent.click(screen.getByText("プロパティ"));
}

describe("MobileIssuePropertiesSection（#1920）", () => {
  beforeEach(() => {
    // `useIssueRepoMeta`のラベル・担当者取得。ここでは中身を使わないので空で返す
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ labels: [], assignees: [] }))),
    );
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("畳んだままでも現在の進捗が読める", () => {
    renderSection({ projectStatus: "Implementation", assignee: { login: "m-guchi" } });

    expect(screen.getByText(/進捗 実装中 ・ 担当 m-guchi/)).toBeTruthy();
  });

  it("Projectへ未登録なら畳んだ行に進捗を出さない（「未着手」と偽らない）", () => {
    renderSection({ projectStatus: null });

    expect(screen.queryByText(/進捗/)).toBeNull();
  });

  it("開くと進捗を変えるセレクトがあり、実行が始まらないことを添える", () => {
    renderSection({ projectStatus: "Implementation" });
    openSection();

    expect(screen.getByLabelText("進捗")).toBeTruthy();
    expect(
      screen.getByText("進捗の状態だけを変更します。実装などの実行は開始しません。"),
    ).toBeTruthy();
  });

  it("開いた中身は進捗・担当者・ラベル・日付の順に並ぶ（PCのパネルと同じ）", () => {
    renderSection({ projectStatus: "Implementation" });
    openSection();

    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["進捗", "担当者", "ラベル", "日付・作成者"]);
  });
});
