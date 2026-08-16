// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateIssueWindow } from "@/components/dashboard/create-issue-window";
import type { Issue } from "@/types/issue";

const broadcastIssueCreated = vi.fn();

vi.mock("@/lib/issue-broadcast", () => ({
  broadcastIssueCreated: (issue: Issue) => broadcastIssueCreated(issue),
}));

/**
 * フォーム本体（`CreateIssueDialog`）は別のテストで見ているため、ここでは受け取った値と
 * 呼び出しだけを見えるようにする。このコンポーネントの担当は「ウィンドウとしての振る舞い」。
 */
vi.mock("@/components/dashboard/create-issue-dialog", () => ({
  CreateIssueDialog: (props: {
    initialHandoff: { title: string; body: string } | null;
    cancelLabel?: string;
    onOpenChange: (open: boolean) => void;
    onCreated: (issue: Issue) => void;
  }) => (
    <div>
      <p data-testid="handoff-title">{props.initialHandoff?.title ?? "（受け渡し無し）"}</p>
      <p data-testid="cancel-label">{props.cancelLabel}</p>
      <button onClick={() => props.onOpenChange(false)}>閉じる操作</button>
      <button onClick={() => props.onCreated({ id: "1" } as Issue)}>作成した</button>
    </div>
  ),
}));

const HANDOFF_KEY = "issue-create-handoff";

function makeStoredHandoff() {
  return JSON.stringify({
    kind: "issue",
    repositoryFullName: "guchi-apps/issue-deck",
    title: "移してきたタイトル",
    body: "移してきた本文",
    selectedLabels: [],
    assignee: null,
    bodyPrefix: null,
    step: "confirm",
    savedAt: Date.now(),
  });
}

describe("CreateIssueWindow", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    broadcastIssueCreated.mockReset();
    vi.restoreAllMocks();
  });

  it("移してきた内容を受け取り、保存を残さない（開き直しで書きかけが復活しない）", () => {
    window.localStorage.setItem(HANDOFF_KEY, makeStoredHandoff());

    render(<CreateIssueWindow repositories={[]} issues={[]} />);

    expect(screen.getByTestId("handoff-title").textContent).toBe("移してきたタイトル");
    expect(window.localStorage.getItem(HANDOFF_KEY)).toBeNull();
  });

  it("URLを直接開いた場合は空のフォームとして始まり、戻り先をデッキにする", () => {
    render(<CreateIssueWindow repositories={[]} issues={[]} />);

    expect(screen.getByTestId("handoff-title").textContent).toBe("（受け渡し無し）");
    // jsdomでは`window.opener`はnull＝このウィンドウを開いた相手がいない
    expect(screen.getByTestId("cancel-label").textContent).toBe("デッキへ戻る");
  });

  it("閉じる操作でウィンドウを閉じ、閉じられなければデッキへ移る", () => {
    vi.useFakeTimers();
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    // jsdomは location への代入を実装していないため、書き込みを記録できる形へ差し替える
    const location = { href: "http://localhost/issues/new" };
    vi.spyOn(window, "location", "get").mockReturnValue(location as unknown as Location);

    render(<CreateIssueWindow repositories={[]} issues={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "閉じる操作" }));

    expect(close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(location.href).toBe("/dashboard");
    vi.useRealTimers();
  });

  it("作成したIssueは元のデッキへ伝える", () => {
    render(<CreateIssueWindow repositories={[]} issues={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "作成した" }));

    expect(broadcastIssueCreated).toHaveBeenCalledWith({ id: "1" });
  });
});
