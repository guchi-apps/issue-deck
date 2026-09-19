// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeReviewRepoOverview } from "@/components/dashboard/code-review-repo-overview";
import type { CodeReviewRepoRow } from "@/lib/code-review-repo-overview";

function row(patch: Partial<CodeReviewRepoRow> & { repositoryFullName: string }): CodeReviewRepoRow {
  return {
    reviews: [],
    lastReviewedAt: null,
    daysSinceLast: null,
    stale: true,
    canRun: true,
    dots: [],
    ...patch,
  };
}

const ROWS = [
  row({ repositoryFullName: "o/new" }),
  row({
    repositoryFullName: "o/deck",
    reviews: [{ issueId: "1", createdAt: "2026-09-17T00:00:00.000Z", pending: false }],
    lastReviewedAt: "2026-09-17T00:00:00.000Z",
    daysSinceLast: 2,
    stale: false,
    canRun: false,
  }),
];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderOverview(props: Partial<React.ComponentProps<typeof CodeReviewRepoOverview>> = {}) {
  const onSelectRepository = vi.fn();
  const onStartCodeReview = vi.fn();
  render(
    <CodeReviewRepoOverview
      rows={ROWS}
      sinceLastCounts={new Map([["o/deck", 38]])}
      countsLoading={false}
      selectedRepositoryFullName={null}
      onSelectRepository={onSelectRepository}
      onStartCodeReview={onStartCodeReview}
      {...props}
    />,
  );
  return { onSelectRepository, onStartCodeReview };
}

/** 一覧は既定でたたんでいる（#3125）。行を見るテストは「すべて表示」を押して開く */
function openList() {
  fireEvent.click(screen.getByRole("button", { name: /すべて表示/ }));
}

describe("CodeReviewRepoOverview", () => {
  it("前回の実施日・回数と、前回以降に入ったPRの件数を数字で出す。未実施は「未実施」", () => {
    renderOverview();
    openList();
    expect(screen.getByText("未実施")).toBeTruthy();
    expect(screen.getByText("2日前・1回")).toBeTruthy();
    expect(screen.getByText("38件")).toBeTruthy();
  });

  it("行を押すとそのリポジトリを選び、選択中の行をもう一度押すと解除する", () => {
    const first = renderOverview();
    openList();
    fireEvent.click(screen.getByRole("button", { name: "deck" }));
    expect(first.onSelectRepository).toHaveBeenCalledWith("o/deck");
    cleanup();

    const second = renderOverview({ selectedRepositoryFullName: "o/deck" });
    fireEvent.click(screen.getByRole("button", { name: "deck" }));
    expect(second.onSelectRepository).toHaveBeenCalledWith(null);
  });

  it("「実行」は実行できる行だけに出し、そのリポジトリを渡す。見出しに別の実行ボタンは無い", () => {
    const { onStartCodeReview } = renderOverview();
    expect(screen.queryByRole("button", { name: "レビューを実行" })).toBeNull();
    openList();
    const runButtons = screen.getAllByRole("button", { name: "実行" });
    expect(runButtons).toHaveLength(1);
    fireEvent.click(runButtons[0]);
    expect(onStartCodeReview).toHaveBeenLastCalledWith("o/new");
  });

  it("たたんでいる間は行も凡例も出さず、「すべて表示」で開き「たたむ」で戻る。件数に関わらず同じ動き", () => {
    renderOverview();
    expect(screen.queryByRole("button", { name: "new" })).toBeNull();
    expect(screen.queryByText("結果待ち")).toBeNull();

    openList();
    expect(screen.getByRole("button", { name: "new" })).toBeTruthy();
    expect(screen.getByText("結果待ち")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "たたむ" }));
    expect(screen.queryByRole("button", { name: "new" })).toBeNull();
    expect(screen.getByRole("button", { name: "すべて表示（2件）" })).toBeTruthy();
  });

  it("選んでいる行はたたんでも残し、ほかの行は隠す", () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      row({ repositoryFullName: `o/repo${index}` }),
    );
    renderOverview({ rows, selectedRepositoryFullName: "o/repo6" });
    expect(screen.queryByRole("button", { name: "repo5" })).toBeNull();
    expect(screen.getByRole("button", { name: "repo6" })).toBeTruthy();

    openList();
    expect(screen.getByRole("button", { name: "repo5" })).toBeTruthy();
  });
});
