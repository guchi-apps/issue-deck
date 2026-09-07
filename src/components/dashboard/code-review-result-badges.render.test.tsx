// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodeReviewProgressBadge,
  CodeReviewResultBadges,
} from "@/components/dashboard/code-review-result-badges";
import type { CodeReviewSummary } from "@/lib/github/code-review";

function summary(patch: Partial<CodeReviewSummary>): CodeReviewSummary {
  return {
    state: "reported",
    counts: { high: 0, medium: 0, low: 0 },
    findingCount: 0,
    findingTitles: [],
    ...patch,
  };
}

afterEach(cleanup);

describe("CodeReviewResultBadges", () => {
  it("重要度ごとの件数を重い順に出し、0件の重要度は出さない", () => {
    render(
      <CodeReviewResultBadges
        summary={summary({ counts: { high: 1, medium: 3, low: 0 }, findingCount: 4 })}
      />,
    );
    expect(screen.getByText("重大 1")).toBeTruthy();
    expect(screen.getByText("中 3")).toBeTruthy();
    expect(screen.queryByText(/^軽微/)).toBeNull();
  });

  it("指摘0件の結果は「指摘なし」（バッジ無しにすると未取得と見分けが付かない）", () => {
    render(<CodeReviewResultBadges summary={summary({})} />);
    expect(screen.getByText("指摘なし")).toBeTruthy();
  });

  it("結果がまだ返っていなければ「レビュー中」", () => {
    render(<CodeReviewResultBadges summary={summary({ state: "pending" })} />);
    expect(screen.getByText("レビュー中")).toBeTruthy();
  });

  it("依頼も結果も無いレビューIssueは「結果なし」", () => {
    render(<CodeReviewResultBadges summary={summary({ state: "missing" })} />);
    expect(screen.getByText("結果なし")).toBeTruthy();
  });

  it("対応状況は重要度バッジの後ろに出す（#2868）", () => {
    const { container } = render(
      <CodeReviewResultBadges
        summary={summary({ counts: { high: 1, medium: 0, low: 0 }, findingCount: 1 })}
        progress={{ total: 6, created: 4, resolved: 2 }}
      />,
    );
    expect(screen.getByText("対応 2/6")).toBeTruthy();
    expect(container.textContent).toBe("重大 1対応 2/6");
  });

  it("対応状況が渡らなければチップを出さない（重要度バッジは今までどおり）", () => {
    render(
      <CodeReviewResultBadges
        summary={summary({ counts: { high: 1, medium: 0, low: 0 }, findingCount: 1 })}
      />,
    );
    expect(screen.getByText("重大 1")).toBeTruthy();
    expect(screen.queryByText(/^対応/)).toBeNull();
  });
});

describe("CodeReviewProgressBadge", () => {
  it("1件も起票していなければ「未起票 N件」（0/Nより「これから起案する」ことが読める）", () => {
    render(<CodeReviewProgressBadge progress={{ total: 3, created: 0, resolved: 0 }} />);
    expect(screen.getByText("未起票 3件")).toBeTruthy();
  });

  it("全部close済みなら「対応済み N/N」", () => {
    render(<CodeReviewProgressBadge progress={{ total: 2, created: 2, resolved: 2 }} />);
    expect(screen.getByText("対応済み 2/2")).toBeTruthy();
  });

  it("途中は「対応 n/N」とバー（完了emerald・起票済みamber）を出す", () => {
    const { container } = render(
      <CodeReviewProgressBadge progress={{ total: 6, created: 4, resolved: 2 }} />,
    );
    expect(screen.getByText("対応 2/6")).toBeTruthy();
    expect(container.querySelector(".bg-emerald-500")).not.toBeNull();
    expect(container.querySelector(".bg-amber-500")).not.toBeNull();
  });

  it("起票済みが全部openならemeraldの塗りは出さない", () => {
    const { container } = render(
      <CodeReviewProgressBadge progress={{ total: 4, created: 1, resolved: 0 }} />,
    );
    expect(screen.getByText("対応 0/4")).toBeTruthy();
    expect(container.querySelector(".bg-emerald-500")).toBeNull();
    expect(container.querySelector(".bg-amber-500")).not.toBeNull();
  });

  it("内訳はホバー・読み上げから読める", () => {
    render(<CodeReviewProgressBadge progress={{ total: 6, created: 4, resolved: 2 }} />);
    const badge = screen.getByLabelText("指摘6件：対応済み2件・起票済み2件・未起票2件");
    expect(badge.getAttribute("title")).toBe("指摘6件：対応済み2件・起票済み2件・未起票2件");
  });
});
