// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueMergeButton } from "@/components/dashboard/issue-merge-button";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";

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

  it("自動マージ可否の判定中は「判定中」を表示して押せなくする（#1968）", () => {
    render(
      <IssueMergeButton
        onMerge={async () => true}
        ciStatus="success"
        mergeJudgement={{ state: "pending", step: null, runUrl: null, aiReview: AI_REVIEW_NONE }}
      />,
    );
    const button = screen.getByRole("button", { name: /判定中/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // なぜ押せないかが分かるよう理由をtitleに出す。
    expect(button.title).toContain("claude-review-develop");
  });

  it("判定が終わっていれば押せる（#1968）", () => {
    render(
      <IssueMergeButton
        onMerge={async () => true}
        ciStatus="success"
        mergeJudgement={{ state: "settled", step: null, runUrl: null, aiReview: AI_REVIEW_NONE }}
      />,
    );
    const button = screen.getByRole("button", { name: /マージする/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("マージ済みのときは「マージ済み」を表示して押せなくする", () => {
    render(<IssueMergeButton onMerge={async () => true} isMerged />);
    const button = screen.getByRole("button", { name: /マージ済み/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("マージ失敗のエラーはボタンの手前にインライン表示する", () => {
    render(<IssueMergeButton onMerge={async () => true} error="コンフリクトしています" />);
    expect(screen.getByText("コンフリクトしています")).not.toBeNull();
  });
});
