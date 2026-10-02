// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IosExtensionIssueDialog } from "@/components/dashboard/ios-extension-issue-dialog";
import type { Issue } from "@/types/issue";

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
  it("内容欄にAI整理・画像抽出ボタンが出て、起票後に「実装を開始」が出る", async () => {
    const issue = { number: 9, repositoryFullName: "guchi-apps/aide-ios" } as Issue;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ issue }), { status: 200 })));
    render(
      <IosExtensionIssueDialog
        target={{ repositoryFullName: "guchi-apps/aide-ios", extension: null }}
        repositories={["guchi-apps/aide-ios"]}
        start={start}
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /音声入力を整理/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /画像から.*抽出/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Issueを起票" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /実装を開始/ })).toBeTruthy());
    expect(start.onIssueUpdated).toHaveBeenCalledWith(issue);
  });
});
