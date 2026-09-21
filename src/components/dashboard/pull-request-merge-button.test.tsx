// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { PullRequestSummary } from "@/types/pull-request";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null,
    ciChecks: [],
    id: "guchi-apps/issue-deck#2075",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 2075,
    title: "v4.19.0をmainへリリースする",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/2075",
    authorLogin: "guchi",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "main",
    headRef: "develop",
    headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    kind: "release",
    linkedIssueNumber: null,
    linkedIssueNumbers: [],
    autoMergeEnabled: false,
    linkedIssueCheckUser: false,
    linkedIssueCheckReason: null,
    ciState: "success",
    mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: true,
    repairWorkflowAvailability: {},
    repairRun: null,
    reviewVerdict: null,
    releaseVerification: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

/** 変更点の取得だけをスタブする（マージ自体はこのテストでは押さない） */
function stubChanges() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ changes: [], commitCount: 0, truncated: false }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PullRequestMergeButton", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("mainへのPRでは確認ダイアログに含まれる変更を出す（#2080）", () => {
    const fetchMock = stubChanges();
    render(<PullRequestMergeButton pullRequest={makePullRequest()} onMerged={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "マージする" }));

    expect(screen.getByText("マージすると本番デプロイが走ります。")).toBeTruthy();
    expect(screen.getByText("このリリースに含まれる変更")).toBeTruthy();
    // 確認の材料は「マージ前の確認」に集約する（#3093）
    expect(screen.getByText("マージ前の確認")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("確認ダイアログは説明を「リポジトリ名 #番号」だけにし、ブランチ名や重複した警告を出さない（#3260）", () => {
    stubChanges();
    render(<PullRequestMergeButton pullRequest={makePullRequest()} onMerged={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "マージする" }));

    expect(screen.getByText("guchi-apps/issue-deck #2075")).toBeTruthy();
    expect(screen.queryByText(/をマージします。/)).toBeNull();
    expect(screen.queryByText(/develop → main/)).toBeNull();
    expect(screen.queryByText(/mainへのマージです/)).toBeNull();
    expect(screen.queryByText(/この判定でマージは止まりません/)).toBeNull();
  });

  it("ボタンは本文のスクロール領域の外（下端）に、キャンセル→マージするの横1列で置く（#3260）", () => {
    stubChanges();
    render(<PullRequestMergeButton pullRequest={makePullRequest()} onMerged={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "マージする" }));

    const dialog = screen.getByRole("alertdialog");
    const footer = dialog.querySelector('[data-slot="alert-dialog-footer"]');
    const scrollBody = dialog.querySelector(".overflow-y-auto");
    expect(footer).not.toBeNull();
    expect(scrollBody).not.toBeNull();
    // フッターは本文（スクロールする側）の子ではない
    expect(scrollBody?.contains(footer)).toBe(false);
    // 横1列（flex-row）で、左がキャンセル・右がマージする
    expect(footer?.className).toContain("flex-row");
    const buttons = Array.from(footer?.querySelectorAll("button") ?? []);
    expect(buttons.map((button) => button.textContent)).toEqual(["キャンセル", "マージする"]);
    // 「マージする」は危険色ではなく他の画面の主ボタンと同じ黒（primary）
    expect(buttons[1].className).toContain("bg-primary");
    expect(buttons[1].className).not.toContain("bg-destructive");
  });

  it("mainへのPRでは、CIの状態を警告リストではなく「マージ前の確認」に出す（#3093）", () => {
    stubChanges();
    render(
      <PullRequestMergeButton
        pullRequest={makePullRequest({ ciState: "failure" })}
        onMerged={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "マージする" }));

    // 警告リストには本番デプロイの1件だけが残り、CIの「失敗」は確認パネルの行に出る
    expect(screen.queryByText("CIが失敗しています。")).toBeNull();
    expect(screen.getByText("失敗")).toBeTruthy();
    expect(screen.getByText("マージすると本番デプロイが走ります。")).toBeTruthy();
  });

  it("develop向けのPRでは出さず、取得もしない", () => {
    const fetchMock = stubChanges();
    render(
      <PullRequestMergeButton
        pullRequest={makePullRequest({
          baseRef: "develop",
          headRef: "issue-2080",
          kind: "issue",
          title: "mainマージ時の確認画面に変更点を表示する",
          ciState: "failure",
        })}
        onMerged={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "マージする" }));

    expect(screen.getByText("CIが失敗しています。")).toBeTruthy();
    expect(screen.queryByText("このリリースに含まれる変更")).toBeNull();
    // 代わりにそのPR1本ぶんのレビュー判定を出す（#2843）
    expect(screen.getByText("コードレビュー")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("自動レビューが要修正なら、CIが通っていても確認ダイアログを通る（#2843）", () => {
    stubChanges();
    render(
      <PullRequestMergeButton
        pullRequest={makePullRequest({
          baseRef: "develop",
          headRef: "issue-2843",
          kind: "issue",
          ciState: "success",
          reviewVerdict: {
            reviewKind: "changes-requested",
            reviewLabel: "要修正",
            riskKind: "hit",
            riskLabel: "該当あり",
            riskReasons: ["認証・認可に関わる変更"],
            confirmLabel: "必要（自動マージはスキップされます）",
            reviewedSha: null,
          },
        })}
        onMerged={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "マージする" }));

    expect(screen.getByText("自動レビューが「要修正」と判定しています。")).toBeTruthy();
    expect(screen.getByText("認証・認可に関わる変更")).toBeTruthy();
  });
});
