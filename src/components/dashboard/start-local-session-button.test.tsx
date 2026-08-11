// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StartLocalSessionButton } from "@/components/dashboard/start-local-session-button";
import type { Issue, IssueLabel } from "@/types/issue";

const updateIssue = vi.fn();
const onFirstLaunch = vi.fn();

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => ({
    updateIssue,
    isSubmitting: false,
    error: null,
  }),
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1049,
    title: "WSL実行時のクイックスタート機能の追加",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "guchi", avatarUrl: "" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1049",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

function label(name: string): IssueLabel {
  return { name, color: "#000000", description: null } as IssueLabel;
}

/** window.location.href への代入を観測できるよう差し替える */
function stubLocation(): { get href(): string } {
  const location = { href: "" };
  Object.defineProperty(window, "location", {
    configurable: true,
    value: location,
  });
  return location;
}

describe("StartLocalSessionButton", () => {
  afterEach(() => {
    cleanup();
    updateIssue.mockReset();
    onFirstLaunch.mockReset();
    // セットアップ手順を見せたかの記録はlocalStorageに残るため、テスト間で持ち越さない（#1088）
    window.localStorage.clear();
  });

  it("openなIssueではボタンを表示する", () => {
    render(
      <StartLocalSessionButton
        issue={makeIssue()}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );

    expect(screen.getByRole("button", { name: /ローカルで開始/ })).not.toBeNull();
  });

  it("ローカル起動プロトコルに適合していないリポジトリでは表示しない（#1073）", () => {
    const { container } = render(
      <StartLocalSessionButton
        issue={makeIssue()}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
        hasLocalStartScript={false}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("リポジトリ情報が無い場合は表示する（誤って導線を消さない）", () => {
    render(
      <StartLocalSessionButton
        issue={makeIssue()}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
        hasLocalStartScript={undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /ローカルで開始/ })).not.toBeNull();
  });

  it("closeされたIssueでは表示しない（起動しても実装対象が無いため）", () => {
    const { container } = render(
      <StartLocalSessionButton
        issue={makeIssue({ state: "closed" })}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("URLを組み立てられないリポジトリ名では表示しない", () => {
    const { container } = render(
      <StartLocalSessionButton
        issue={makeIssue({ repositoryFullName: "guchi-apps/issue deck" })}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("押下すると11.localを付与してからissuedeck://へ遷移する", async () => {
    const location = stubLocation();
    const issue = makeIssue();
    const updated = makeIssue({ labels: [label("11.local")] });
    updateIssue.mockResolvedValue(updated);
    const onIssueUpdated = vi.fn();

    render(
      <StartLocalSessionButton
        issue={issue}
        onIssueUpdated={onIssueUpdated}
        onFirstLaunch={onFirstLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));

    await waitFor(() => {
      expect(location.href).toBe("issuedeck://start/guchi-apps/issue-deck/1049");
    });
    expect(updateIssue).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 1049,
      labels: ["11.local"],
    });
    expect(onIssueUpdated).toHaveBeenCalledWith(updated);
  });

  it("既に11.localが付いていればラベル更新はせず起動だけ行う", async () => {
    const location = stubLocation();

    render(
      <StartLocalSessionButton
        issue={makeIssue({ labels: [label("11.local"), label("50.feature")] })}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));

    await waitFor(() => {
      expect(location.href).toBe("issuedeck://start/guchi-apps/issue-deck/1049");
    });
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("ラベル付与に失敗しても起動は妨げない", async () => {
    const location = stubLocation();
    updateIssue.mockResolvedValue(null);
    const onIssueUpdated = vi.fn();

    render(
      <StartLocalSessionButton
        issue={makeIssue()}
        onIssueUpdated={onIssueUpdated}
        onFirstLaunch={onFirstLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));

    await waitFor(() => {
      expect(location.href).toBe("issuedeck://start/guchi-apps/issue-deck/1049");
    });
    expect(onIssueUpdated).not.toHaveBeenCalled();
  });

  // プロトコルが登録済みかはブラウザから検知できないため、初回だけこちらから見せる（#1088）
  it("初回の押下ではセットアップ手順の表示を要求する", async () => {
    stubLocation();

    render(
      <StartLocalSessionButton
        issue={makeIssue({ labels: [label("11.local")] })}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));

    await waitFor(() => {
      expect(onFirstLaunch).toHaveBeenCalledTimes(1);
    });
  });

  it("2回目以降の押下ではセットアップ手順を要求しない", async () => {
    const location = stubLocation();

    render(
      <StartLocalSessionButton
        issue={makeIssue({ labels: [label("11.local")] })}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));
    await waitFor(() => {
      expect(onFirstLaunch).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));
    await waitFor(() => {
      expect(location.href).toBe("issuedeck://start/guchi-apps/issue-deck/1049");
    });
    expect(onFirstLaunch).toHaveBeenCalledTimes(1);
  });
});
