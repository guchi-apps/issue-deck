// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromotionPullRequestActions } from "@/components/dashboard/knowledge-board-panel";
import type { OpenPromotionPullRequest } from "@/lib/knowledge-board";

function makePullRequest(
  overrides: Partial<OpenPromotionPullRequest> = {},
): OpenPromotionPullRequest {
  return {
    number: 134,
    title: "フリートの知見メモを共有知識へ格上げする",
    htmlUrl: "https://github.com/guchi-apps/docs/pull/134",
    createdAt: "2026-09-14T00:00:00.000Z",
    sourceIssues: [
      {
        repoFullName: "guchi-apps/issue-deck",
        number: 2950,
        htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/2950",
      },
    ],
    ...overrides,
  };
}

function stubFetchOk() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PromotionPullRequestActions", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("マージすると既存のPRマージ機構を guchi-apps/docs 向けに叩き、完了を伝える", async () => {
    const fetchMock = stubFetchOk();
    const onDone = vi.fn();
    render(<PromotionPullRequestActions pr={makePullRequest()} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "マージする" }));
    fireEvent.click(screen.getAllByRole("button", { name: "マージする" }).at(-1)!);

    await screen.findByText("マージ済み");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/issues/pull-request-merge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ owner: "guchi-apps", repo: "docs", number: 134 }),
      }),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("マージしないと既存のPRクローズ機構を guchi-apps/docs 向けに叩き、完了を伝える", async () => {
    const fetchMock = stubFetchOk();
    const onDone = vi.fn();
    render(<PromotionPullRequestActions pr={makePullRequest()} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "マージしない" }));
    fireEvent.click(screen.getAllByRole("button", { name: "マージしない" }).at(-1)!);

    await screen.findByText("マージしませんでした");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/issues/pull-request-close",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ owner: "guchi-apps", repo: "docs", number: 134 }),
      }),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
