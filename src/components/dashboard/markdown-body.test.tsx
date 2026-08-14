// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GithubReferenceNavigationProvider } from "@/components/dashboard/github-reference-navigation";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import type { GithubReference } from "@/lib/github-reference";

afterEach(() => cleanup());

function renderBody(content: string, openReference: (reference: GithubReference) => void) {
  return render(
    <GithubReferenceNavigationProvider openReference={openReference}>
      <MarkdownBody content={content} repositoryFullName="guchi-apps/issue-deck" />
    </GithubReferenceNavigationProvider>,
  );
}

function click(element: Element): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(element, event);
  return event;
}

describe("MarkdownBody のリンク", () => {
  // `#123`はrehypeLinkifyIssueRefsがGitHubのURLへ展開したうえで、クリック時に
  // アプリ内遷移へ差し替わる（#1260）
  it("本文中の #番号 はアプリ内でIssueを開く", () => {
    const openReference = vi.fn();
    renderBody("詳細は #1260 を参照。", openReference);

    const event = click(screen.getByText("#1260"));

    expect(openReference).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 1260,
      kind: "issue",
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("本文中のPRのURLはアプリ内でPRを開く", () => {
    const openReference = vi.fn();
    renderBody("対応PR: https://github.com/guchi-apps/issue-deck/pull/42", openReference);

    click(screen.getByText("https://github.com/guchi-apps/issue-deck/pull/42"));

    expect(openReference).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 42,
      kind: "pull",
    });
  });

  it("GitHub以外・Issue/PR以外のリンクは別タブで開く外部リンクのまま", () => {
    const openReference = vi.fn();
    renderBody(
      "[実行ログ](https://github.com/guchi-apps/issue-deck/actions/runs/1) と [公式](https://example.com)",
      openReference,
    );

    const runLink = screen.getByText("実行ログ");
    expect(click(runLink).defaultPrevented).toBe(false);
    expect(click(screen.getByText("公式")).defaultPrevented).toBe(false);
    expect(openReference).not.toHaveBeenCalled();
    expect(runLink.getAttribute("target")).toBe("_blank");
  });
});
