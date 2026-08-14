// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueMergeButton } from "@/components/dashboard/issue-merge-button";

describe("IssueMergeButton", () => {
  afterEach(() => {
    cleanup();
  });

  it("確認ダイアログでマージするとonMergedを呼ぶ", async () => {
    const onMerge = vi.fn(async () => true);
    const onMerged = vi.fn();
    render(<IssueMergeButton onMerge={onMerge} onMerged={onMerged} pullRequestNumber={674} />);

    fireEvent.click(screen.getByRole("button", { name: /マージする/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /マージする/ }).at(-1)!);

    await waitFor(() => {
      expect(onMerged).toHaveBeenCalledTimes(1);
    });
    expect(onMerge).toHaveBeenCalledTimes(1);
  });

  it("マージに失敗した場合はonMergedを呼ばない", async () => {
    const onMerge = vi.fn(async () => false);
    const onMerged = vi.fn();
    render(<IssueMergeButton onMerge={onMerge} onMerged={onMerged} pullRequestNumber={674} />);

    fireEvent.click(screen.getByRole("button", { name: /マージする/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /マージする/ }).at(-1)!);

    await waitFor(() => {
      expect(onMerge).toHaveBeenCalledTimes(1);
    });
    expect(onMerged).not.toHaveBeenCalled();
  });

  it("CI実行中はボタンがdisabledになる", () => {
    render(<IssueMergeButton onMerge={async () => true} ciStatus="in_progress" />);
    const button = screen.getByRole("button", { name: /マージする/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("マージ済みのときは「マージ済み」を表示して押せなくする", () => {
    render(<IssueMergeButton onMerge={async () => true} isMerged />);
    const button = screen.getByRole("button", { name: /マージ済み/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("アイコン表示でもラベルからマージ操作だと分かる", () => {
    render(<IssueMergeButton onMerge={async () => true} appearance="icon" />);
    expect(screen.getByRole("button", { name: "マージする" })).not.toBeNull();
  });

  it("アイコン表示ではCI実行中に押せない理由をラベルで示す", () => {
    render(<IssueMergeButton onMerge={async () => true} appearance="icon" ciStatus="in_progress" />);
    const button = screen.getByRole("button", {
      name: "CI実行中のためマージできません",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
