// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CodeReviewResultBadges } from "@/components/dashboard/code-review-result-badges";
import type { CodeReviewSummary } from "@/lib/github/code-review";

function summary(patch: Partial<CodeReviewSummary>): CodeReviewSummary {
  return {
    state: "reported",
    counts: { high: 0, medium: 0, low: 0 },
    findingCount: 0,
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
});
