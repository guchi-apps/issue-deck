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

describe("修正の実行状態とレビュー範囲の確認待ち（#4498）", () => {
  const gap = checks({ aiReview: { state: "needs_check", findingCount: 0, reviewedFiles: 65, totalFiles: 71, reason: "未確認範囲があります" } });

  it("指摘0件で確認が65/71件: レビュー範囲の確認待ち。修正Issue作成を主操作にしない", () => {
    const o = describeFixOverview({ series: series("stopped", 745), checks: gap });
    expect(o.pill).toBe("レビュー範囲の確認待ち");
    expect(o.action.kind).toBe("none");
    expect(o.autoProgress).toBe(false);
    expect(o.detail).toContain("65/71ファイルを確認");
    expect(o.checksLine).toContain("指摘0件・範囲の確認待ち（65/71ファイルを確認）");
  });

  it("件数が取れなくても、needs_checkで指摘0件なら範囲の確認待ちにする", () => {
    const o = describeFixOverview({ series: null, checks: checks({ aiReview: { state: "needs_check", findingCount: 0, reason: "未確認範囲があります: x" } }) });
    expect(o.pill).toBe("レビュー範囲の確認待ち");
  });

  it("実際の指摘がある場合は従来どおり修正が必要", () => {
    const o = describeFixOverview({ series: null, checks: checks({ aiReview: { state: "needs_check", findingCount: 2 } }) });
    expect(o.pill).toBe("修正が必要");
    expect(o.action.kind).toBe("create_issue");
  });

  it("レビューの実行失敗（指摘なし）は修正指摘にしない", () => {
    const o = describeFixOverview({ series: null, checks: checks({ aiReview: { state: "failed", findingCount: 0, reason: "タイムアウト" } }) });
    expect(o.pill).toBe("レビューの実行に失敗");
    expect(o.action.kind).toBe("none");
  });

  it("修正の実装中と修正PRの検証中を分ける", () => {
    const failing = checks({ aiReview: { state: "needs_check", findingCount: 3 } });
    const implementing = describeFixOverview({ series: { ...series("fix_in_progress"), fixPrNumber: null }, checks: failing });
    expect(implementing.pill).toBe("修正中");
    expect(implementing.detail).toContain("未解決の指摘3件");
    expect(implementing.autoProgress).toBe(true);
    const verifying = describeFixOverview({ series: { ...series("fix_in_progress"), fixPrNumber: 740 }, checks: failing });
    expect(verifying.pill).toBe("修正PRの検証中");
    expect(verifying.headline).toContain("#740");
  });

  it("未開始・停止は自動進行中と表示しない", () => {
    expect(describeFixOverview({ series: series("issue_created"), checks: null }).autoProgress).toBe(false);
    expect(describeFixOverview({ series: series("stopped"), checks: checks() }).autoProgress).toBe(false);
  });

  it("進行中の完了系列を主見出しにし、未解決指摘は説明として添える。修正Issue作成は出さない", () => {
    const failing = checks({ aiReview: { state: "needs_check", findingCount: 3 } });
    const o = describeFixOverview({ series: null, checks: failing, completion: { status: "fixing", active: true, candidatePrNumber: 4555 } });
    expect(o.pill).toBe("修正中");
    expect(o.detail).toContain("未解決の指摘3件");
    expect(o.action.kind).toBe("none");
    expect(o.autoProgress).toBe(true);
  });

  it("取り込み後の候補検証中は修正前の結果を現在値にしない", () => {
    const old = checks({ aiReview: { state: "needs_check", findingCount: 3 } });
    const o = describeFixOverview({ series: null, checks: old, completion: { status: "checking", active: true, candidatePrNumber: 4560 } });
    expect(o.pill).toBe("修正後の再検証中");
    expect(o.headline).toContain("#4560");
    expect(o.detail).toContain("履歴");
  });
});

describe("describeFixOverview: 内部確認の一時停止（#4587）", () => {
  const pause = { message: "実行予算に達したため一時停止しています", nextAction: "予算を追加して再開する", autoResumable: false };
  it("修正中でも一時停止なら自動で進むとは言わず、原因と次の操作を出す", () => {
    const o = describeFixOverview({ series: { ...series("fix_in_progress"), internalPause: pause }, checks: null });
    expect(o.pill).toBe("一時停止");
    expect(o.autoProgress).toBe(false);
    expect(o.detail).toContain("次の操作: 予算を追加して再開する");
  });
  it("実行環境の障害を本人確認待ち（あなたの操作が必要）にはしない", () => {
    const o = describeFixOverview({ series: { ...series("fix_in_progress"), internalPause: { ...pause, autoResumable: true } }, checks: null });
    expect(o.pill).toBe("一時停止（再開可）");
    expect(o.pill).not.toBe("あなたの操作が必要");
  });
});
