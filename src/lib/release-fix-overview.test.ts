import { describe, expect, it } from "vitest";

import type { ReleaseFixStatus } from "@/lib/release-fix-series";
import {
  describeFixOverview,
  RELEASE_FIX_PHASES,
  releaseFixPhaseIndex,
  summarizeChecks,
  type OverviewChecks,
} from "@/lib/release-fix-overview";

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
  rebuildFailed: false,
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
    expect(describeFixOverview({ series: series("rebuilding"), checks: old }).headline).toBe("修正を反映したリリース候補を準備しています");
    expect(describeFixOverview({ series: series("reverifying", 4394), checks: old }).pill).toBe("チェック中");
  });

  it("通過なら公開操作待ち。取得失敗は問題なしとしない", () => {
    expect(describeFixOverview({ series: null, checks: checks() }).pill).toBe("公開操作待ち");
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

describe("describeFixOverview: 作り直しの失敗と時系列（#4398）", () => {
  it("準備に失敗: 失敗と原因を出し、作成済みの修正Issueを重複して作らない", () => {
    const failing = checks({ aiReview: { state: "failed", findingCount: 2 } });
    const o = describeFixOverview({ series: { ...series("stopped"), rebuildFailed: true, stopReason: "候補の作り直しに失敗しました" }, checks: failing });
    expect(o.headline).toBe("修正を反映したリリースの準備に失敗しました");
    expect(o.detail).toBe("候補の作り直しに失敗しました");
    expect(o.action.kind).toBe("retry_rebuild");
    expect(o.pill).not.toContain("承認待ち");
    // 修正前のチェックが通っていても「本番承認待ち」へ落ちない
    expect(describeFixOverview({ series: { ...series("stopped"), rebuildFailed: true }, checks: checks() }).pill).toBe("準備に失敗");
  });

  it("新しいチェックの片方だけ完了していても承認待ちにしない", () => {
    const o = describeFixOverview({ series: series("ready", 4400), checks: checks({ integration: { state: "running" } }) });
    expect(o.pill).toBe("チェック中");
    expect(o.tone).toBe("progress");
  });

  it("新しいリリースPRが出る前（作り直し中）は修正前の結果で承認待ち・指摘を出さない", () => {
    const o = describeFixOverview({ series: series("rebuilding"), checks: checks() });
    expect(o.pill).toBe("修正取り込み準備中");
    expect(o.action.kind).toBe("view_progress");
  });
});

describe("summarizeChecks", () => {
  it("全体レビュー・統合検証・Mac検証を1行にする", () => {
    expect(summarizeChecks(checks({ aiReview: { state: "failed", findingCount: 2 }, mac: { state: "passed" } }))).toBe(
      "全体レビュー: 指摘2件 ／ 統合検証: 問題なし ／ Mac検証: 問題なし",
    );
  });
});

describe("操作不要の判定と工程（#4428）", () => {
  it("待てば進む状態だけautoProgressにし、失敗・判断待ち・公開操作待ちは待機扱いしない", () => {
    const series = (status: string, extra: Record<string, unknown> = {}) =>
      ({ status, issueNumber: 1, successorPrNumber: null, stopReason: "理由", ...extra }) as never;
    expect(describeFixOverview({ series: series("rebuilding"), checks: null }).autoProgress).toBe(true);
    expect(describeFixOverview({ series: series("fix_merged"), checks: null }).autoProgress).toBe(true);
    expect(describeFixOverview({ series: series("awaiting_decision"), checks: null }).autoProgress).toBe(false);
    expect(describeFixOverview({ series: series("stopped", { rebuildFailed: true }), checks: null }).autoProgress).toBe(false);
    expect(describeFixOverview({ series: null, checks: null, checksError: true }).autoProgress).toBe(false);
  });

  it("内部の7段階を修正→取り込み→再検証→公開の4つへまとめる", () => {
    expect(RELEASE_FIX_PHASES).toEqual(["修正", "取り込み", "再検証", "公開"]);
    expect([0, 1, 2, 3, 4, 5, 6].map(releaseFixPhaseIndex)).toEqual([0, 0, 0, 1, 1, 2, 3]);
  });
});

describe("内部確認の保留（#4410）", () => {
  it("内部確認が済まないまま修正PRが現れた判断待ちは、無関係な変更の確認とは別の表示にする", () => {
    const overview = describeFixOverview({
      series: { ...series("awaiting_decision"), stopReason: "内部確認: 独立レビューが未実施です。内部確認が完了するまで修正を候補へ取り込みません" },
      checks: checks(),
    });
    expect(overview.pill).toBe("内部確認が必要");
    expect(overview.action.kind).toBe("view_progress");
  });
  it("無関係な変更の判断待ちは従来どおり", () => {
    const overview = describeFixOverview({ series: { ...series("awaiting_decision"), stopReason: "修正と無関係な変更（#1）が入りました" }, checks: checks() });
    expect(overview.action.kind).toBe("accept_extra");
  });
});
