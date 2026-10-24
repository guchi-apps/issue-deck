// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileScreenFab } from "@/components/dashboard/mobile/mobile-screen-fab";

afterEach(cleanup);

describe("MobileScreenFab", () => {
  it("Issueの作成ができ、横断質問のボタンは出ない（#2660・#4991）", () => {
    const onCreateIssue = vi.fn();
    render(<MobileScreenFab onCreateIssue={onCreateIssue} onOpenRemoteSessions={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "新しいIssueを作成" }));

    expect(onCreateIssue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "複数リポジトリに質問する" })).toBeNull();
  });

  it("起動中のリモートセッションの本数をバッジに出す（#4991）", () => {
    render(<MobileScreenFab onCreateIssue={() => {}} onOpenRemoteSessions={() => {}} remoteSessionCount={2} />);

    expect(screen.getByRole("button", { name: "リモートセッションを開く" }).textContent).toBe("2");
  });

  it("リモートセッションを開くボタンから画面遷移を呼ぶ（#4091・#4743）", () => {
    const onOpenRemoteSessions = vi.fn();
    render(
      <MobileScreenFab onCreateIssue={() => {}} onOpenRemoteSessions={onOpenRemoteSessions} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "リモートセッションを開く" }));

    expect(onOpenRemoteSessions).toHaveBeenCalledTimes(1);
  });

  // #1945: 一覧の行が内側の重なり順にz-indexを使うため、指定が無いと丸ボタンが行の後ろへ回る
  it("丸ボタンを一覧より手前の層に置く", () => {
    render(<MobileScreenFab onCreateIssue={() => {}} onOpenRemoteSessions={() => {}} />);

    const fabs = screen.getByRole("button", { name: "新しいIssueを作成" }).parentElement!;
    expect(fabs.className).toContain("z-20");
  });

  // #1645: 絞り込み行など下端の固定帯がある画面では、それを避けて上げる
  it("raisedを渡すと下端の帯を避けた位置に上がる", () => {
    render(
      <MobileScreenFab raised onCreateIssue={() => {}} onOpenRemoteSessions={() => {}} />,
    );

    const fabs = screen.getByRole("button", { name: "新しいIssueを作成" }).parentElement!;
    expect(fabs.className).toContain("bottom-22");
    expect(fabs.className).not.toContain("bottom-4");
  });

  it("raisedを渡さないと画面下端に接する位置になる", () => {
    render(<MobileScreenFab onCreateIssue={() => {}} onOpenRemoteSessions={() => {}} />);

    const fabs = screen.getByRole("button", { name: "新しいIssueを作成" }).parentElement!;
    expect(fabs.className).toContain("bottom-4");
  });
});
