// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleaseFixStartButton } from "@/components/dashboard/release-fix-panel";
import { ReleaseFixStartContext } from "@/components/dashboard/release-fix-start-context";

vi.mock("@/hooks/use-reference-navigation", () => ({
  useReferenceNavigation: () => ({ openIssue: vi.fn(), openPullRequest: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReleaseFixStartButton", () => {
  it("Contextが無ければ何も出さない", () => {
    const { container } = render(<ReleaseFixStartButton repositoryFullName="o/r" seriesId="s1" startState="none" />);
    expect(container.textContent).toBe("");
  });

  it("確認が通れば開始ダイアログへIssueを渡す", async () => {
    const issue = { id: "i1", number: 5 };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, issue }), { status: 200 })));
    const open = vi.fn();
    render(
      <ReleaseFixStartContext.Provider value={open}>
        <ReleaseFixStartButton repositoryFullName="o/r" seriesId="s1" startState="none" />
      </ReleaseFixStartContext.Provider>,
    );
    fireEvent.click(screen.getByText("修正を開始"));
    await waitFor(() => expect(open).toHaveBeenCalledWith(issue));
  });

  it("失敗してもIssueは作成済みと伝え、再試行できる", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "確認待ちです" }), { status: 409 })));
    render(
      <ReleaseFixStartContext.Provider value={vi.fn()}>
        <ReleaseFixStartButton repositoryFullName="o/r" seriesId="s1" startState="none" />
      </ReleaseFixStartContext.Provider>,
    );
    fireEvent.click(screen.getByText("修正を開始"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("修正Issueは作成済みです"));
    expect(screen.getByText("もう一度開始")).toBeTruthy();
  });

  it("受付済みなら状態と「進捗を見る」を出す", () => {
    render(
      <ReleaseFixStartContext.Provider value={vi.fn()}>
        <ReleaseFixStartButton repositoryFullName="o/r" seriesId="s1" startState="queued" />
      </ReleaseFixStartContext.Provider>,
    );
    expect(screen.getByText("受付済み・起動待ち")).toBeTruthy();
    expect(screen.getByText("進捗を見る")).toBeTruthy();
  });
});
