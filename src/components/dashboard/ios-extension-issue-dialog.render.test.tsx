// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IosExtensionIssueDialog } from "@/components/dashboard/ios-extension-issue-dialog";
import type { Issue } from "@/types/issue";

// 実装開始ダイアログ本体は多数のフックに依存するため、開いたかどうかだけを見る
vi.mock("@/components/dashboard/start-implementation-dialog", () => ({
  StartImplementationDialog: ({ issue }: { issue: { number: number } }) => <div data-testid="start-dialog">#{issue.number}</div>,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const start = {
  repositories: [],
  issues: [],
  onIssueUpdated: vi.fn(),
  claudeLocalModel: "default",
  codexModel: "default",
} as unknown as Parameters<typeof IosExtensionIssueDialog>[0]["start"];

describe("IosExtensionIssueDialog", () => {
  const issue = { number: 9, repositoryFullName: "guchi-apps/aide-ios" } as Issue;

  function setup(onClose = vi.fn()) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ issue }), { status: 200 })));
    render(
      <IosExtensionIssueDialog
        target={{ repositoryFullName: "guchi-apps/aide-ios", extension: null }}
        repositories={["guchi-apps/aide-ios"]}
        start={start}
        onClose={onClose}
      />,
    );
    return onClose;
  }

  it("内容欄にAI整理・画像抽出ボタンが出る", () => {
    setup();
    expect(screen.getByRole("button", { name: /音声入力を整理/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /画像から.*抽出/ })).toBeTruthy();
  });

  it("「作成」は起票して一覧へ戻り、「起票しました」画面を出さない", async () => {
    const onClose = setup();
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(start.onIssueUpdated).toHaveBeenCalledWith(issue);
    expect(screen.queryByText(/を起票しました/)).toBeNull();
    expect(screen.queryByRole("button", { name: /実装を開始/ })).toBeNull();
  });

  it("「作成+実装開始」は起票して一覧へ戻したうえで実装開始ダイアログを開く", async () => {
    const onClose = setup();
    fireEvent.click(screen.getByRole("button", { name: "作成+実装開始" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("start-dialog").textContent).toBe("#9"));
  });
});
