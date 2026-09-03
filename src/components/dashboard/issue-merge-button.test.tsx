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

  it("対応PRの状態を取得中は「確認中」を表示して押せなくする（#2352）", () => {
    render(<IssueMergeButton onMerge={async () => true} isDetailPending />);
    const button = screen.getByRole("button", { name: /確認中/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // 押せない理由が分かるようtitleに出す
    expect(button.title).toContain("確認しています");
    expect(screen.queryByRole("button", { name: /^マージする/ })).toBeNull();
  });

  it("取得が終われば押せる（#2352）", () => {
    render(
      <IssueMergeButton
        onMerge={async () => true}
        ciStatus="success"
        mergeJudgement={{ state: "settled", step: null, runUrl: null, aiReview: AI_REVIEW_NONE }}
        isDetailPending={false}
      />,
    );
    const button = screen.getByRole("button", { name: /マージする/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("この画面でマージ済みにした行は、取得中でも「マージ済み」のままにする（#2352）", () => {
    render(<IssueMergeButton onMerge={async () => true} isDetailPending isMerged />);
    expect(screen.getByRole("button", { name: /マージ済み/ })).not.toBeNull();
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

  describe("マージしない（#2780）", () => {
    it("onDeclineを渡さない場合はボタンを出さない", () => {
      render(<IssueMergeButton onMerge={async () => true} />);
      expect(screen.queryByRole("button", { name: /マージしない/ })).toBeNull();
    });

    it("確認ダイアログで確定するとonDeclinedを呼ぶ", async () => {
      const onDecline = vi.fn(async () => true);
      const onDeclined = vi.fn();
      render(
        <IssueMergeButton
          onMerge={async () => true}
          onDecline={onDecline}
          onDeclined={onDeclined}
          pullRequestNumber={674}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /^マージしない$/ }));
      fireEvent.click(screen.getAllByRole("button", { name: /マージしない/ }).at(-1)!);

      await waitFor(() => {
        expect(onDeclined).toHaveBeenCalledTimes(1);
      });
      expect(onDecline).toHaveBeenCalledTimes(1);
    });

    it("クローズに失敗した場合はonDeclinedを呼ばない", async () => {
      const onDecline = vi.fn(async () => false);
      const onDeclined = vi.fn();
      render(
        <IssueMergeButton onMerge={async () => true} onDecline={onDecline} onDeclined={onDeclined} />,
      );

      fireEvent.click(screen.getByRole("button", { name: /^マージしない$/ }));
      fireEvent.click(screen.getAllByRole("button", { name: /マージしない/ }).at(-1)!);

      await waitFor(() => {
        expect(onDecline).toHaveBeenCalledTimes(1);
      });
      expect(onDeclined).not.toHaveBeenCalled();
    });

    it("CI実行中・判定中でも「マージしない」は押せる（却下したいのはまさにこの状態のため）", () => {
      render(
        <IssueMergeButton
          onMerge={async () => true}
          onDecline={async () => true}
          ciStatus="in_progress"
          mergeJudgement={{ state: "pending", step: null, runUrl: null, aiReview: AI_REVIEW_NONE }}
        />,
      );
      const declineButton = screen.getByRole("button", { name: /^マージしない$/ }) as HTMLButtonElement;
      expect(declineButton.disabled).toBe(false);
    });

    it("マージ済みのときは「マージしない」を出さない", () => {
      render(<IssueMergeButton onMerge={async () => true} onDecline={async () => true} isMerged />);
      expect(screen.queryByRole("button", { name: /マージしない/ })).toBeNull();
    });
  });
});
