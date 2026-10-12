// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepositoryReleaseButton } from "@/components/dashboard/repository-release-button";

const requestRelease = vi.fn(async () => {});
vi.mock("@/lib/release-request", () => ({
  get requestRelease() { return requestRelease; },
}));

afterEach(() => {
  cleanup();
  requestRelease.mockClear();
});

describe("本番デプロイ失敗中の修正リリース", () => {
  it("確認チェック後だけ明示的な上書きで起動できる", async () => {
    render(
      <RepositoryReleaseButton
        repositoryFullName="guchi-apps/issue-deck"
        isPending={false}
        blockedReason="deploy-failed"
        onTriggered={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "修正リリース" }));
    const action = screen.getByRole("button", { name: "起動する" });
    expect(action.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(action.hasAttribute("disabled")).toBe(false);
    fireEvent.click(action);
    expect(requestRelease).toHaveBeenCalledWith("guchi-apps/issue-deck", undefined, true);
  });
});

describe("リリース準備の状態（#4421）", () => {
  it("準備中は灰色の「リリース準備中」で案内を出すが、確認チェック後は起動できる", () => {
    render(
      <RepositoryReleaseButton
        repositoryFullName="o/r"
        isPending={false}
        blockedReason="release-preparing"
        onTriggered={() => {}}
      />,
    );
    expect(screen.getByText(/操作せずお待ちください/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "リリース準備中" }));
    const action = screen.getByRole("button", { name: "起動する" });
    expect(action.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(action);
    expect(requestRelease).toHaveBeenCalledWith("o/r", undefined, false);
  });

  it("準備失敗のときは待機中と案内せず、帯からの再開へ誘導する", () => {
    render(
      <RepositoryReleaseButton
        repositoryFullName="o/r"
        isPending={false}
        blockedReason="preparation-failed"
        onTriggered={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "準備に失敗" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("お待ちください");
    expect(screen.getByText(/「再開」してください/)).toBeTruthy();
  });
});
