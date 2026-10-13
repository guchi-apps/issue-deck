// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepositoryReleaseButton } from "@/components/dashboard/repository-release-button";

const requestRelease = vi.fn(async (...args: unknown[]) => (void args, { kind: "legacy" as const }));
let startMode: { mode: string; label?: string } | null = { mode: "legacy", label: "未対応" };
vi.mock("@/lib/release-request", () => ({
  requestReleaseStart: (repo: string, options: { bumpKind?: unknown; allowFailedDeploy?: boolean }) =>
    requestRelease(repo, options.bumpKind, options.allowFailedDeploy ?? false),
  newRequestKey: () => "rc-test-key-1234",
}));
vi.mock("@/hooks/use-release-start-mode", () => ({ useReleaseStartMode: () => startMode }));

afterEach(() => {
  cleanup();
  requestRelease.mockClear();
  startMode = { mode: "legacy", label: "未対応" };
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

describe("開始方式（#4604）", () => {
  const base = { repositoryFullName: "o/r", isPending: false, onTriggered: () => {} };

  it("取得中は操作できず、取得後に新方式の説明で確認する", () => {
    startMode = null;
    const { rerender } = render(<RepositoryReleaseButton {...base} />);
    const button = screen.getByRole("button", { name: "開始方式を確認中" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByText("リリースworkflowを起動しますか？")).toBeNull();
    expect(requestRelease).not.toHaveBeenCalled();
    startMode = { mode: "candidate" };
    rerender(<RepositoryReleaseButton {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "候補を作成して検証" }));
    expect(screen.getByText("リリース候補を作成して検証しますか？")).toBeTruthy();
  });

  it("新方式に対応したrepoでは「候補を作成して検証」と出し、上げ幅の選択を出さない", () => {
    startMode = { mode: "candidate" };
    render(<RepositoryReleaseButton {...base} />);
    fireEvent.click(screen.getByRole("button", { name: /候補を作成して検証/ }));
    expect(screen.getByText("リリース候補を作成して検証しますか？")).toBeTruthy();
    expect(screen.queryByText(/上げ幅/)).toBeNull();
  });

  it("判定できないrepoでは押せず、理由を出す", () => {
    startMode = { mode: "unknown", label: "判定できません" };
    render(<RepositoryReleaseButton {...base} />);
    expect((screen.getByRole("button", { name: /リリースする/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("判定できません")).toBeTruthy();
  });
});
