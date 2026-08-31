// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileScreenFab } from "@/components/dashboard/mobile/mobile-screen-fab";

afterEach(cleanup);

describe("MobileScreenFab", () => {
  it("Issueの作成と複数リポジトリへの質問ができる（#2660）", () => {
    const onCreateIssue = vi.fn();
    const onAskCrossRepoQuestion = vi.fn();
    render(
      <MobileScreenFab onCreateIssue={onCreateIssue} onAskCrossRepoQuestion={onAskCrossRepoQuestion} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新しいIssueを作成" }));
    fireEvent.click(screen.getByRole("button", { name: "複数リポジトリに質問する" }));

    expect(onCreateIssue).toHaveBeenCalledTimes(1);
    expect(onAskCrossRepoQuestion).toHaveBeenCalledTimes(1);
  });

  // #1945: 一覧の行が内側の重なり順にz-indexを使うため、指定が無いと丸ボタンが行の後ろへ回る
  it("丸ボタンを一覧より手前の層に置く", () => {
    render(<MobileScreenFab onCreateIssue={() => {}} onAskCrossRepoQuestion={() => {}} />);

    const fabs = screen.getByRole("button", { name: "新しいIssueを作成" }).parentElement!;
    expect(fabs.className).toContain("z-20");
  });

  // #1645: 絞り込み行など下端の固定帯がある画面では、それを避けて上げる
  it("raisedを渡すと下端の帯を避けた位置に上がる", () => {
    render(
      <MobileScreenFab raised onCreateIssue={() => {}} onAskCrossRepoQuestion={() => {}} />,
    );

    const fabs = screen.getByRole("button", { name: "新しいIssueを作成" }).parentElement!;
    expect(fabs.className).toContain("bottom-22");
    expect(fabs.className).not.toContain("bottom-4");
  });

  it("raisedを渡さないと画面下端に接する位置になる", () => {
    render(<MobileScreenFab onCreateIssue={() => {}} onAskCrossRepoQuestion={() => {}} />);

    const fabs = screen.getByRole("button", { name: "新しいIssueを作成" }).parentElement!;
    expect(fabs.className).toContain("bottom-4");
  });
});
