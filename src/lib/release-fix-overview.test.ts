import { describe, expect, it } from "vitest";

import type { ReleaseFixStatus } from "@/lib/release-fix-series";
import { describeFixOverview, summarizeChecks, type OverviewChecks } from "@/lib/release-fix-overview";

const checks = (over: Partial<OverviewChecks> = {}): OverviewChecks => ({
  aiReview: { state: "passed", findingCount: 0 },
  integration: { state: "passed" },
  ...over,
});
const series = (status: ReleaseFixStatus, successor: number | null = null) => ({
  status,
  issueNumber: 4395,
  successorPrNumber: successor,
  stopReason: "理由",
});

describe("describeFixOverview", () => {
  it("修正を反映したが指摘が残る（#4394相当）: 残件数と「修正Issueを作成」を最初に出す", () => {
    const o = describeFixOverview({
      series: series("stopped", 4394),
      checks: checks({ aiReview: { state: "needs_check", findingCount: 2 } }),
    });
    expect(o.headline).toBe("修正を反映しましたが、チェックで2件の指摘が残っています");
    expect(o.remainingFindings).toBe(2);
    expect(o.action.kind).toBe("create_issue");
    expect(o.pill).not.toContain("承認待ち");
  });

  it("Issue未作成・作成済み未開始・実行中で主操作が変わる", () => {
    const failing = checks({ aiReview: { state: "failed", findingCount: 1 } });
    expect(describeFixOverview({ series: null, checks: failing }).action.kind).toBe("create_issue");
    expect(describeFixOverview({ series: series("issue_created"), checks: failing }).action.kind).toBe("start_fix");
    expect(describeFixOverview({ series: series("fix_in_progress"), checks: failing }).action.kind).toBe("view_progress");
  });

  it("作り直し中・再チェック中は修正前の指摘を現在状態にしない", () => {
    const old = checks({ aiReview: { state: "failed", findingCount: 3 } });
    expect(describeFixOverview({ series: series("rebuilding"), checks: old }).headline).toBe("修正版のリリースを準備しています");
    expect(describeFixOverview({ series: series("reverifying", 4394), checks: old }).pill).toBe("チェック中");
  });

  it("通過なら本番承認待ち。取得失敗は問題なしとしない", () => {
    expect(describeFixOverview({ series: null, checks: checks() }).pill).toBe("本番承認待ち");
    const err = describeFixOverview({ series: null, checks: null, checksError: true });
    expect(err.headline).toContain("問題なしとは扱いません");
    expect(err.action.kind).toBe("none");
  });

  it("判断待ちは理由と操作を隣に出す", () => {
    const o = describeFixOverview({ series: series("awaiting_decision"), checks: null });
    expect(o.detail).toBe("理由");
    expect(o.action.kind).toBe("accept_extra");
  });
});

describe("summarizeChecks", () => {
  it("全体レビュー・統合検証・Mac検証を1行にする", () => {
    expect(summarizeChecks(checks({ aiReview: { state: "failed", findingCount: 2 }, mac: { state: "passed" } }))).toBe(
      "全体レビュー: 指摘2件 ／ 統合検証: 問題なし ／ Mac検証: 問題なし",
    );
  });
});
