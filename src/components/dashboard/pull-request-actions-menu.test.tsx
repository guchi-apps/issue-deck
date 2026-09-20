// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PullRequestActionsMenu } from "@/components/dashboard/pull-request-actions-menu";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { PullRequestSummary } from "@/types/pull-request";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ciRunId: null,
    ciChecks: [],
    id: "guchi-apps/issue-deck#3170",
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    number: 3170,
    title: "PR詳細に編集・クローズ操作を足す",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/pull/3170",
    authorLogin: "guchi",
    draft: false,
    state: "open",
    merged: false,
    mergedAt: null,
    baseRef: "develop",
    headRef: "issue-3161",
    headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    kind: "issue",
    linkedIssueNumber: 3161,
    linkedIssueNumbers: [3161],
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
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

/** Radixのメニュー・ダイアログがjsdomに無いAPIを呼ぶので埋めておく */
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

/** 「…」を開く（Radixのメニューはpointerdownで開く） */
function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "PRの操作メニュー" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function renderMenu(
  pullRequest: PullRequestSummary,
  { body = "## 対応Issue\n#3161", onUpdated = vi.fn(), onClosed = vi.fn() }: {
    body?: string | null;
    onUpdated?: () => void;
    onClosed?: () => void;
  } = {},
) {
  render(
    <PullRequestActionsMenu
      pullRequest={pullRequest}
      body={body}
      onUpdated={onUpdated}
      onClosed={onClosed}
    />,
  );
  return { onUpdated, onClosed };
}

describe("PullRequestActionsMenu", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stubPointerApis();
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("OpenのPRでは「編集」と「クローズする」を出す", () => {
    renderMenu(makePullRequest());
    openMenu();

    expect(screen.getByRole("menuitem", { name: "編集" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "クローズする" })).toBeTruthy();
  });

  it.each([
    ["マージ済み", { state: "closed" as const, merged: true }],
    ["クローズ済み", { state: "closed" as const, merged: false }],
  ])("%sのPRでは「編集」だけを出す", (_label, overrides) => {
    renderMenu(makePullRequest(overrides));
    openMenu();

    expect(screen.getByRole("menuitem", { name: "編集" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "クローズする" })).toBeNull();
  });

  it("本文の取得前は「編集」を押せない（空の本文で上書きしないため）", () => {
    renderMenu(makePullRequest(), { body: null });
    openMenu();

    expect(screen.getByRole("menuitem", { name: "編集" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("「クローズする」は確認を挟み、確認してからクローズAPIを呼ぶ", async () => {
    const { onClosed } = renderMenu(makePullRequest({ autoMergeEnabled: true }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "クローズする" }));

    // 押しただけでは呼ばない
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("このPRをクローズしますか？")).toBeTruthy();
    expect(screen.getByText("紐付くIssue #3161 はクローズしません")).toBeTruthy();
    expect(screen.getByText("Auto-mergeが有効です。クローズすると自動マージも止まります。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "クローズする" }));

    await waitFor(() => expect(onClosed).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/issues/pull-request-close",
      expect.objectContaining({
        body: JSON.stringify({ owner: "guchi-apps", repo: "issue-deck", number: 3170 }),
      }),
    );
  });

  it("クローズに失敗したらダイアログに理由を出し、onClosedは呼ばない", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: "github_api_error", message: "Resource not accessible" }),
    });
    const { onClosed } = renderMenu(makePullRequest());
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "クローズする" }));
    fireEvent.click(screen.getByRole("button", { name: "クローズする" }));

    expect(await screen.findByText(/Resource not accessible/)).toBeTruthy();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("「編集」はタイトルと本文を保存し、保存できたらonUpdatedを呼ぶ", async () => {
    const { onUpdated } = renderMenu(makePullRequest());
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "編集" }));

    const titleInput = screen.getByLabelText("タイトル") as HTMLInputElement;
    expect(titleInput.value).toBe("PR詳細に編集・クローズ操作を足す");
    fireEvent.change(titleInput, { target: { value: "新しいタイトル" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pull-requests/update",
      expect.objectContaining({
        body: JSON.stringify({
          owner: "guchi-apps",
          repo: "issue-deck",
          number: 3170,
          title: "新しいタイトル",
          body: "## 対応Issue\n#3161",
        }),
      }),
    );
  });
});
