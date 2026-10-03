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
        pendingIssues={[]}
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
