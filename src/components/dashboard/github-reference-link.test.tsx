// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { GithubReferenceNavigationProvider } from "@/components/dashboard/github-reference-navigation";
import type { GithubReference } from "@/lib/github-reference";

afterEach(() => cleanup());

function renderLink(
  props: { href: string; reference?: GithubReference | null },
  openReference?: (reference: GithubReference) => void,
) {
  const link = (
    <GithubReferenceLink href={props.href} reference={props.reference}>
      リンク
    </GithubReferenceLink>
  );
  return render(
    openReference ? (
      <GithubReferenceNavigationProvider openReference={openReference}>
        {link}
      </GithubReferenceNavigationProvider>
    ) : (
      link
    ),
  );
}

describe("GithubReferenceLink", () => {
  it("IssueのURLは通常クリックでアプリ内遷移し、GitHubへは移動しない", () => {
    const openReference = vi.fn();
    renderLink({ href: "https://github.com/guchi-apps/issue-deck/issues/1260" }, openReference);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(screen.getByText("リンク"), event);

    expect(openReference).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 1260,
      kind: "issue",
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("修飾キー付きのクリックは既定の動作（GitHubを別タブで開く）に任せる", () => {
    const openReference = vi.fn();
    renderLink({ href: "https://github.com/guchi-apps/issue-deck/pull/42" }, openReference);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    fireEvent(screen.getByText("リンク"), event);

    expect(openReference).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("Issue・PR以外のURLは外部リンクのまま", () => {
    const openReference = vi.fn();
    renderLink(
      { href: "https://github.com/guchi-apps/issue-deck/actions/runs/1" },
      openReference,
    );

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(screen.getByText("リンク"), event);

    expect(openReference).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("providerが無い場所では外部リンクとして振る舞う", () => {
    renderLink({ href: "https://github.com/guchi-apps/issue-deck/issues/1" });

    const link = screen.getByText("リンク");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(false);
    expect(link.getAttribute("href")).toBe("https://github.com/guchi-apps/issue-deck/issues/1");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("referenceを明示した場合はhrefの解析より優先する", () => {
    const openReference = vi.fn();
    renderLink(
      {
        href: "https://github.com/guchi-apps/issue-deck/issues/7",
        reference: { repositoryFullName: "guchi-apps/issue-deck", number: 7, kind: "pull" },
      },
      openReference,
    );

    fireEvent(
      screen.getByText("リンク"),
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openReference).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 7,
      kind: "pull",
    });
  });
});
