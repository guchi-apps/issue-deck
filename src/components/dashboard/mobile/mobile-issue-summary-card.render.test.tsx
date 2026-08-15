// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileIssueSummaryCard } from "@/components/dashboard/mobile/mobile-issue-summary-card";
import type { Issue, IssueLabel } from "@/types/issue";

function label(name: string): IssueLabel {
  return { name, color: "cccccc", description: null };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    number: 1645,
    title: "スマホのissue一覧画面のフィルター部分のデザイン改善",
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
    commentCount: 3,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1645",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function renderCard(overrides: Partial<Issue> = {}) {
  render(<MobileIssueSummaryCard issue={issue(overrides)} onSelectRepository={vi.fn()} />);
}

describe("MobileIssueSummaryCard（#1646）", () => {
  afterEach(() => {
    cleanup();
  });

  it("リポジトリ・タイトル・状態・コメント数を1枚に出す", () => {
    renderCard();

    expect(screen.getByText("guchi-apps/issue-deck")).toBeTruthy();
    expect(screen.getByText(/#1645 スマホのissue一覧画面/)).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("進捗（Project Status）を出す", () => {
    renderCard({ projectStatus: "Implementation" });

    expect(screen.getByText("実装中")).toBeTruthy();
  });

  it("Projectへ未登録なら進捗を出さない（「未着手」と偽らない）", () => {
    renderCard({ projectStatus: null });

    expect(screen.queryByText("未着手")).toBeNull();
  });

  it("確認待ちのときは理由まで出し、進捗の代わりに前へ出す", () => {
    renderCard({
      projectStatus: "Develop PR",
      labels: [label("00.check-user"), label("01.check-merge")],
    });

    expect(screen.getByText("確認待ち・PRのマージ")).toBeTruthy();
    expect(screen.queryByText("developへマージ")).toBeNull();
  });

  it("担当者が未設定なら作成者を出す", () => {
    renderCard();

    expect(screen.getByText("m-guchi")).toBeTruthy();
  });

  it("担当者がいればそちらを出す", () => {
    renderCard({ assignee: { login: "someone-else" } });

    expect(screen.getByText("someone-else")).toBeTruthy();
    expect(screen.queryByText("m-guchi")).toBeNull();
  });

  it("ラベルは上限まで出し、あふれた件数を添える", () => {
    renderCard({
      labels: [
        label("62.design"),
        label("11.local"),
        label("25.artifact-required"),
        label("80.Priority: High"),
      ],
    });

    expect(screen.getByText("62.design")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
  });

  it("ラベルの削除ボタンは置かない（編集はプロパティ側の役割）", () => {
    renderCard({ labels: [label("62.design")] });

    expect(screen.queryByLabelText("62.designを削除")).toBeNull();
  });
});
