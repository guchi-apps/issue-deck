import { describe, expect, it } from "vitest";

import {
  toReleaseCandidateFix,
  decideReleaseFixStart,
  buildReleaseFixIssue,
  buildReleaseFixSourceKey,
  canStartNextGeneration,
  legacyReviewFindingKey,
  normalizeFindingTitle,
  reviewFindingKey,
  isLegacyGenerationLimitStopReason,
  classifyIntegrationFailure,
  decideReleaseFix,
  decideReverification,
  decideReverificationFollowUp,
  isLegacyReverificationStopReason,
  isRcImportFailureReason,
  isRebuildFailureReason,
  rcImportFailureReason,
  REBUILD_FAILURE_REASONS,
  releaseFixStepIndex,
  type ReleaseFixSeriesSnapshot,
} from "@/lib/release-fix-series";

const snapshot = (over: Partial<ReleaseFixSeriesSnapshot> = {}): ReleaseFixSeriesSnapshot => ({
  id: "s1",
  status: "fix_in_progress",
  issueNumber: 10,
  fixPrNumber: 100,
  fixPrMerged: true,
  fixPrClosedUnmerged: false,
  acceptedExtraPrs: [],
  ...over,
});
const open = { originStillOpen: true, originMerged: false, developPullRequests: [] as number[] };

describe("buildReleaseFixSourceKey", () => {
  const base = {
    repositoryFullName: "o/r",
    baseSha: "a",
    sourceKind: "review_finding" as const,
  };
  it("指摘の並び順や重複に依らず同じ鍵になる", () => {
    expect(buildReleaseFixSourceKey({ ...base, itemKeys: ["x", "y"] })).toBe(
      buildReleaseFixSourceKey({ ...base, itemKeys: ["y", "x", "x"] }),
    );
  });
  it("baseが変われば別の鍵になる（mainが進んだ後の再発は前提の違う別の対象）", () => {
    expect(buildReleaseFixSourceKey({ ...base, itemKeys: ["x"] })).not.toBe(
      buildReleaseFixSourceKey({ ...base, baseSha: "c", itemKeys: ["x"] }),
    );
  });
  it("後継候補（headもPR番号も変わる）で同じ指摘が再発すると、祖先の鍵と一致して止まる（#4766）", () => {
    const parentKey = buildReleaseFixSourceKey({ ...base, itemKeys: [reviewFindingKey({ title: "設定漏れ", file: "a.ts" })] });
    const successorKey = buildReleaseFixSourceKey({ ...base, itemKeys: [reviewFindingKey({ title: "設定漏れ。", file: "a.ts" })] });
    expect(canStartNextGeneration({ sourceKey: successorKey, ancestorSourceKeys: [parentKey] })).toMatchObject({ ok: false });
  });
});

describe("reviewFindingKey（#4766）", () => {
  it("行番号に依存しない", () => {
    expect(reviewFindingKey({ title: "設定漏れ", file: "a.ts", line: 3 })).toBe(reviewFindingKey({ title: "設定漏れ", file: "a.ts", line: 40 }));
  });
  it("空白・句読点・記号・大小・全角半角の揺れを除く", () => {
    expect(normalizeFindingTitle(" `Env`の 設定漏れ、！ ")).toBe(normalizeFindingTitle("ｅｎｖの設定漏れ"));
    expect(reviewFindingKey({ title: "API key missing.", file: "a.ts" })).toBe(reviewFindingKey({ title: "api-key missing", file: "a.ts" }));
  });
  it("ファイルが違えば別の指摘", () => {
    expect(reviewFindingKey({ title: "設定漏れ", file: "a.ts" })).not.toBe(reviewFindingKey({ title: "設定漏れ", file: "b.ts" }));
  });
  it("旧キーは題・ファイル・行のまま（旧IDの照合用）", () => {
    expect(legacyReviewFindingKey({ title: " 設定漏れ ", file: "a.ts", line: 3 })).toBe("設定漏れ|a.ts|3");
  });
});

describe("classifyIntegrationFailure", () => {
  it("終了コード126や接続失敗は実行障害", () => {
    expect(classifyIntegrationFailure("command exited with code 126")).toBe("execution");
    expect(classifyIntegrationFailure("connect ECONNREFUSED 127.0.0.1")).toBe("execution");
  });
  it("テスト・ビルドの失敗はコードの不具合", () => {
    expect(classifyIntegrationFailure("pnpm test: 3 tests failed")).toBe("code");
  });
  it("判断が付かないものはunknown（コード修正を強制しない）", () => {
    expect(classifyIntegrationFailure("")).toBe("unknown");
    expect(classifyIntegrationFailure("something odd")).toBe("unknown");
  });
});

describe("decideReleaseFix", () => {
  it("修正PRが揃うまで待つ", () => {
    expect(
      decideReleaseFix({ series: [snapshot(), snapshot({ id: "s2", fixPrMerged: false })], candidate: open }),
    ).toEqual({ action: "wait" });
  });
  it("全部マージ済みで無関係な変更が無ければ作り直す", () => {
    const decision = decideReleaseFix({
      series: [snapshot(), snapshot({ id: "s2", fixPrNumber: 101 })],
      candidate: { ...open, developPullRequests: [100, 101] },
    });
    expect(decision).toEqual({ action: "rebuild", seriesIds: ["s1", "s2"], selectedPrs: [] });
  });
  it("選んだ作り直しに対応していれば、無関係な変更があっても修正PRだけを選んで作り直す（#4335）", () => {
    const decision = decideReleaseFix({
      series: [snapshot()],
      candidate: { ...open, developPullRequests: [100, 200] },
      selective: true,
    });
    expect(decision).toEqual({ action: "rebuild", seriesIds: ["s1"], selectedPrs: [100] });
  });
  it("選んだ作り直しでは、確認済みのPRも足すが、developに入っていないものは選ばない", () => {
    const decision = decideReleaseFix({
      series: [snapshot({ acceptedExtraPrs: [200, 300] })],
      candidate: { ...open, developPullRequests: [100, 200] },
      selective: true,
    });
    expect(decision).toEqual({ action: "rebuild", seriesIds: ["s1"], selectedPrs: [100, 200] });
  });
  it("選んだ作り直しで足す修正PRが無ければ止める", () => {
    const decision = decideReleaseFix({
      series: [snapshot()],
      candidate: { ...open, developPullRequests: [200] },
      selective: true,
    });
    expect(decision).toMatchObject({ action: "stop", status: "stopped" });
  });
  it("無関係な変更が入っていたら作り直さず判断待ちにする", () => {
    const decision = decideReleaseFix({
      series: [snapshot()],
      candidate: { ...open, developPullRequests: [100, 200] },
    });
    expect(decision).toMatchObject({ action: "stop", status: "awaiting_decision" });
    expect(decision.action === "stop" && decision.reason).toContain("#200");
  });
  it("確認済みの無関係な変更は含めて作り直す", () => {
    const decision = decideReleaseFix({
      series: [snapshot({ acceptedExtraPrs: [200] })],
      candidate: { ...open, developPullRequests: [100, 200] },
    });
    expect(decision.action).toBe("rebuild");
  });
  it("元候補が取消・置換されていたら誤った候補へ取り込まず対象外にする", () => {
    expect(
      decideReleaseFix({ series: [snapshot()], candidate: { ...open, originStillOpen: false } }),
    ).toMatchObject({ action: "stop", status: "superseded" });
    expect(
      decideReleaseFix({ series: [snapshot()], candidate: { ...open, originStillOpen: false, originMerged: true } }),
    ).toMatchObject({ action: "stop", status: "superseded" });
  });
  it("修正PRがマージされずに閉じたら理由付きで止める", () => {
    expect(
      decideReleaseFix({ series: [snapshot({ fixPrMerged: false, fixPrClosedUnmerged: true })], candidate: open }),
    ).toMatchObject({ action: "stop", status: "stopped" });
  });
  it("作り直し済みの系列は対象にしない（二重の作り直しを起こさない）", () => {
    expect(decideReleaseFix({ series: [snapshot({ status: "rebuilding" })], candidate: open })).toEqual({
      action: "wait",
    });
  });
});

describe("decideReverification", () => {
  it("両方成功のときだけ準備完了", () => {
    expect(decideReverification({ integration: "passed", aiReview: "passed" })).toBe("ready");
    expect(decideReverification({ integration: "passed", aiReview: "not_applicable" })).toBe("ready");
  });
  it("どちらかが未完了なら待つ", () => {
    expect(decideReverification({ integration: "passed", aiReview: "pending" })).toBe("pending");
  });
  it("失敗・要確認は修正へ戻す", () => {
    expect(decideReverification({ integration: "failed", aiReview: "passed" })).toBe("needs_fix");
    expect(decideReverification({ integration: "passed", aiReview: "needs_check" })).toBe("needs_fix");
  });
});

describe("canStartNextGeneration", () => {
  it("世代数が多くても、同一指摘の再発でなければ続ける（#4589）", () => {
    const ancestors = Array.from({ length: 20 }, (_, i) => `a${i}`);
    expect(canStartNextGeneration({ sourceKey: "new", ancestorSourceKeys: ancestors })).toEqual({ ok: true });
  });
  it("旧い上限停止の理由を判別する", () => {
    expect(isLegacyGenerationLimitStopReason("修正の反復が上限（3回）に達しました。原因を人が整理してから進めてください。リリース画面の…")).toBe(true);
    expect(isLegacyGenerationLimitStopReason("修正PRがマージされずに閉じられました")).toBe(false);
    expect(isLegacyGenerationLimitStopReason(null)).toBe(false);
  });
  it("同一の指摘が再発したら止める", () => {
    expect(canStartNextGeneration({ sourceKey: "k", ancestorSourceKeys: ["k"] })).toMatchObject({
      ok: false,
    });
    expect(canStartNextGeneration({ sourceKey: "k2", ancestorSourceKeys: ["k"] })).toEqual({ ok: true });
  });
});

describe("releaseFixStepIndex", () => {
  it("状態ごとの現在地", () => {
    expect(releaseFixStepIndex({ status: "issue_created", fixPrNumber: null, successorPrNumber: null })).toBe(1);
    expect(releaseFixStepIndex({ status: "fix_in_progress", fixPrNumber: 3, successorPrNumber: null })).toBe(2);
    expect(releaseFixStepIndex({ status: "ready", fixPrNumber: 3, successorPrNumber: 9 })).toBe(6);
    expect(releaseFixStepIndex({ status: "stopped", fixPrNumber: 3, successorPrNumber: 9 })).toBe(5);
  });
});

describe("buildReleaseFixIssue", () => {
  it("機密を除いた根拠・SHA・元PR・検証条件を引き継ぎ、目印を先頭に置く", () => {
    const { title, body } = buildReleaseFixIssue(
      {
        repositoryFullName: "o/r",
        releasePrNumber: 5,
        releaseVersion: "1.2.3",
        baseSha: "aaaa",
        headSha: "bbbb",
        sourceKind: "review_finding",
        causeClass: "decision",
        items: [{ title: "T", detail: "d", file: "a.ts:3", evidence: "e", recommendation: "r", pullRequests: [7] }],
        decisionQuestion: "AかBか",
        previousIssueNumber: 9,
        generation: 2,
        relatedPullRequests: [7],
        verifyConditions: ["条件1"],
      },
      "key123",
    );
    expect(title).toContain("#5");
    expect(body.startsWith("<!-- issue-deck-release-fix:key123 -->")).toBe(true);
    for (const text of ["aaaa", "bbbb", "v1.2.3", "AかB", "#9", "#7", "条件1", "a.ts:3"]) {
      expect(body).toContain(text);
    }
  });
});

describe("decideReleaseFixStart（#4396）", () => {
  const base = { status: "issue_created", hasSuccessor: false, issueState: "open", startState: "none" } as const;
  it("未開始のissue_createdは開始できる", () => {
    expect(decideReleaseFixStart(base)).toEqual({ ok: true });
  });
  it("後継の世代がある・修正PRが進んでいる・閉じている・起動済みは弾く", () => {
    expect(decideReleaseFixStart({ ...base, hasSuccessor: true })).toMatchObject({ ok: false, reason: "superseded" });
    expect(decideReleaseFixStart({ ...base, status: "fix_in_progress" })).toMatchObject({ ok: false, reason: "not_startable" });
    expect(decideReleaseFixStart({ ...base, issueState: "closed" })).toMatchObject({ ok: false, reason: "issue_closed" });
    expect(decideReleaseFixStart({ ...base, startState: "queued" })).toMatchObject({ ok: false, reason: "already_started" });
    expect(decideReleaseFixStart({ ...base, startState: "running" })).toMatchObject({ ok: false, reason: "already_started" });
  });
});

describe("候補の取得が不完全なとき（#4422）", () => {
  it("足すPRが見つからなくても、取得が不完全なら停止せず待つ", () => {
    const decision = decideReleaseFix({
      selective: true,
      series: [{ id: "s", status: "fix_merged", issueNumber: 1, fixPrNumber: 10, fixPrMerged: true, fixPrClosedUnmerged: false, acceptedExtraPrs: [] }],
      candidate: { originStillOpen: true, originMerged: false, developPullRequests: [], complete: false },
    });
    expect(decision.action).toBe("wait");
  });
});

describe("内部確認（#4410）の保留", () => {
  it("修正PRが内部確認の未完了・不一致のまま現れたら、マージ済みでも作り直しへ進めず判断待ちにする", () => {
    const decision = decideReleaseFix({ series: [snapshot({ internalHold: "内部確認: 独立レビューが未実施です" })], candidate: open, selective: true });
    expect(decision).toMatchObject({ action: "stop", status: "awaiting_decision", seriesIds: ["s1"] });
  });
  it("保留が無ければ従来どおり作り直す（旧い系列は影響を受けない）", () => {
    const decision = decideReleaseFix({ series: [snapshot()], candidate: { ...open, developPullRequests: [100] }, selective: true });
    expect(decision).toMatchObject({ action: "rebuild", selectedPrs: [100] });
  });
  it("修正PRがまだ無い系列は保留しない（PRが出るまで待つ）", () => {
    const decision = decideReleaseFix({ series: [snapshot({ fixPrNumber: null, fixPrMerged: false, internalHold: "内部確認: x" })], candidate: open });
    expect(decision).toEqual({ action: "wait" });
  });
});

describe("修正Issue本文の内部確認の手順", () => {
  const input = {
    repositoryFullName: "o/r",
    releasePrNumber: 5,
    releaseVersion: "1.0.0",
    baseSha: "a",
    headSha: "b",
    sourceKind: "review_finding" as const,
    causeClass: "code" as const,
    items: [{ title: "指摘", detail: null, file: null, evidence: null, recommendation: null, pullRequests: [] }],
    decisionQuestion: null,
    previousIssueNumber: null,
    generation: 1,
    relatedPullRequests: [],
    verifyConditions: ["x"],
  };
  it("内部確認つきの起案には手順と、PR作成スクリプトの案内が入る", () => {
    const { body } = buildReleaseFixIssue({ ...input, internalReview: true }, "k");
    expect(body).toContain("## 内部確認");
    expect(body).toContain("scripts/create-release-fix-pr.sh");
  });
  it("報告コマンドには対象リポジトリの--repoが付き、他リポジトリはissue-deckのスクリプトを案内する（#4964）", () => {
    const own = buildReleaseFixIssue({ ...input, repositoryFullName: "guchi-apps/issue-deck", internalReview: true }, "k").body;
    expect(own).toContain("`scripts/report-release-fix-round.sh claim <issue番号> <担当名> --repo guchi-apps/issue-deck`");
    expect(own).not.toContain("~/apps/issue-deck/scripts");
    const other = buildReleaseFixIssue({ ...input, repositoryFullName: "guchi-apps/kurashio", internalReview: true }, "k").body;
    expect(other).toContain("`~/apps/issue-deck/scripts/report-release-fix-round.sh claim <issue番号> <担当名> --repo guchi-apps/kurashio`");
    expect(other).toContain("`~/apps/issue-deck/scripts/create-release-fix-pr.sh --repo guchi-apps/kurashio");
    for (const action of ["review", "test", "claim", "pause"]) {
      expect(other).toMatch(new RegExp(`report-release-fix-round\\.sh ${action} [^\`]*--repo guchi-apps/kurashio\``));
    }
  });
  it("指定しなければ従来の本文のまま", () => {
    expect(buildReleaseFixIssue(input, "k").body).not.toContain("## 内部確認");
  });
});

describe("decideReverificationFollowUp（#4478）", () => {
  const sec = (state: string, over: Partial<{ reason: string | null; summary: string | null; findingCount: number }> = {}) => ({
    state,
    reason: null,
    summary: null,
    findingCount: 0,
    ...over,
  });
  it("全体レビューの指摘は全件を次世代へ戻す", () => {
    expect(decideReverificationFollowUp({ integration: sec("passed"), aiReview: sec("needs_check", { findingCount: 2 }) })).toEqual({
      action: "continue",
      sourceKind: "review_finding",
    });
  });
  it("コード由来の統合検証失敗は継続する", () => {
    expect(decideReverificationFollowUp({ integration: sec("failed", { reason: "テストが failed" }), aiReview: sec("passed") })).toEqual({
      action: "continue",
      sourceKind: "integration_failure",
    });
  });
  it("実行障害は起案せず待つ", () => {
    expect(decideReverificationFollowUp({ integration: sec("passed"), aiReview: sec("failed") }).action).toBe("wait_rerun");
  });
  it("判別できない失敗・指摘が読めない確認要求は本人へ", () => {
    expect(decideReverificationFollowUp({ integration: sec("failed"), aiReview: sec("passed") }).action).toBe("human");
    expect(decideReverificationFollowUp({ integration: sec("passed"), aiReview: sec("needs_check") }).action).toBe("human");
  });
});

describe("isLegacyReverificationStopReason", () => {
  it("旧い停止理由だけを判別する", () => {
    expect(isLegacyReverificationStopReason("後継候補 #11 の再検証で指摘・失敗が残りました（世代 2）。後継候補から")).toBe(true);
    expect(isLegacyReverificationStopReason("修正の反復が上限に達しました")).toBe(false);
    expect(isLegacyReverificationStopReason(null)).toBe(false);
  });
});

describe("rcImportFailureReason（#4895）", () => {
  it("止まった段階を理由に入れる", () => {
    expect(rcImportFailureReason({ kind: "request", error: "candidate_changed" })).toContain(
      "取り込みの依頼に失敗: 候補ブランチが記録したrevisionのheadから動いています",
    );
    expect(rcImportFailureReason({ kind: "failed", detail: "競合" })).toContain("取り込みのrevisionが失敗: 競合");
    expect(rcImportFailureReason({ kind: "failed", detail: null })).toContain("理由の記録なし");
    expect(rcImportFailureReason({ kind: "expired" })).toContain("取り込みのrevisionが期限切れ");
  });

  it("段階つきの理由も、従来の理由も「準備に失敗」として判別する", () => {
    const reason = rcImportFailureReason({ kind: "expired" });
    expect(isRcImportFailureReason(reason)).toBe(true);
    expect(isRebuildFailureReason(reason)).toBe(true);
    expect(isRcImportFailureReason(REBUILD_FAILURE_REASONS.rc)).toBe(true);
    expect(isRcImportFailureReason(REBUILD_FAILURE_REASONS.full)).toBe(false);
  });
});


describe("toReleaseCandidateFix（#4972）", () => {
  const row = (o: Record<string, unknown> = {}) => ({
    status: "fix_in_progress", issueNumber: 7, sourceKind: "review_finding", stopReason: null, internalStopReason: null, ...o,
  }) as Parameters<typeof toReleaseCandidateFix>[0];

  it("起案〜反映待ちは対応中、内部確認の停止は停止扱い", () => {
    for (const status of ["issue_created", "fix_in_progress", "fix_merged", "rebuilding"]) {
      expect(toReleaseCandidateFix(row({ status }))).toMatchObject({ stalled: false, issueNumber: 7 });
    }
    expect(toReleaseCandidateFix(row({ internalStopReason: "上限" }))).toMatchObject({ stalled: true, reason: "上限" });
  });

  it("判断待ちと作り直しの失敗は停止、再検証以降と通常のstoppedは検証結果に任せる", () => {
    expect(toReleaseCandidateFix(row({ status: "awaiting_decision", stopReason: "仕様の判断が必要" }))).toMatchObject({ stalled: true });
    expect(toReleaseCandidateFix(row({ status: "stopped", stopReason: REBUILD_FAILURE_REASONS.full }))).toMatchObject({ stalled: true });
    for (const status of ["reverifying", "ready", "superseded"]) expect(toReleaseCandidateFix(row({ status }))).toBeNull();
    expect(toReleaseCandidateFix(row({ status: "stopped", stopReason: "再検証が失敗" }))).toBeNull();
  });
});
