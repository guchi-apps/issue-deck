import { describe, expect, it } from "vitest";

import {
  decideCompletionMerge,
  decideReleaseCompletion,
  RELEASE_COMPLETION_FIX_START_TIMEOUT_MS,
  releaseCompletionStageIndex,
  type CompletionChecks,
  type CompletionMergeObservation,
  type CompletionSeriesSnapshot,
  type ReleaseCompletionState,
} from "@/lib/release-completion";
import { NOTHING_TO_ADD_REASON, REVERIFY_FAILED_MARKER } from "@/lib/release-fix-series";

const now = new Date("2026-10-12T12:00:00Z");

function run(overrides: Partial<ReleaseCompletionState> = {}): ReleaseCompletionState {
  return {
    status: "investigating",
    scope: "until_production",
    startedByUserId: "u1",
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    stoppedAt: null,
    candidatePrNumber: 10,
    candidateHeadSha: "head1",
    candidateBaseSha: "base1",
    dispatchedSeriesId: null,
    dispatchedAt: null,
    costLimitUsd: 30,
    costUsedUsd: 0,
    ...overrides,
  };
}

const openCandidate = { number: 10, state: "open" as const, merged: false, headSha: "head1", baseSha: "base1", mergeCommitSha: null };

function series(overrides: Partial<CompletionSeriesSnapshot> = {}): CompletionSeriesSnapshot {
  return {
    id: "s1",
    status: "issue_created",
    issueNumber: 100,
    fixPrNumber: null,
    stopReason: null,
    successorPrNumber: null,
    successorHeadSha: null,
    successorBaseSha: null,
    startState: "none",
    ...overrides,
  };
}

const passed: CompletionChecks = {
  aiReview: "passed",
  integration: "passed",
  mac: "not_applicable",
  findingCount: 0,
  integrationFailureKind: null,
  integrationSetupGap: false,
};

describe("decideReleaseCompletion", () => {
  it("修正Issueが未開始なら、その系列を1回だけ起動する", () => {
    const decision = decideReleaseCompletion(run(), { now, candidate: openCandidate, series: series(), checks: null });
    expect(decision).toEqual({ action: "dispatch_fix", seriesId: "s1", issueNumber: 100 });
    // 起動済みの系列は重ねて起動しない
    const again = decideReleaseCompletion(run({ dispatchedSeriesId: "s1", dispatchedAt: now }), { now, candidate: openCandidate, series: series(), checks: null });
    expect(again).toEqual({ action: "wait", status: "fixing", note: null });
  });

  it("起動したのに修正PRが現れないまま時間が過ぎたら止める", () => {
    const decision = decideReleaseCompletion(
      run({ dispatchedSeriesId: "s1", dispatchedAt: new Date(now.getTime() - RELEASE_COMPLETION_FIX_START_TIMEOUT_MS) }),
      { now, candidate: openCandidate, series: series(), checks: null },
    );
    expect(decision).toMatchObject({ action: "stop", reason: "fix_not_started" });
  });

  it("費用の上限に達したら、新しい起動をしない", () => {
    const decision = decideReleaseCompletion(run({ costUsedUsd: 30 }), { now, candidate: openCandidate, series: series(), checks: null });
    expect(decision).toEqual({ action: "stop", reason: "cost_limit" });
  });

  it("修正系列が作り直した後継へ追従する（元の候補が閉じられていても）", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: { ...openCandidate, state: "closed" },
      series: series({ status: "reverifying", successorPrNumber: 11, successorHeadSha: "head2", successorBaseSha: "base1" }),
      checks: null,
    });
    expect(decision).toEqual({ action: "follow_successor", prNumber: 11, headSha: "head2", baseSha: "base1" });
  });

  it("系列の外で候補が閉じられた・作り直されたら追わない", () => {
    expect(decideReleaseCompletion(run(), { now, candidate: { ...openCandidate, state: "closed" }, series: null, checks: passed })).toEqual({
      action: "stop",
      reason: "candidate_closed",
    });
    expect(
      decideReleaseCompletion(run(), { now, candidate: { ...openCandidate, headSha: "other" }, series: null, checks: passed }),
    ).toMatchObject({ action: "stop", reason: "candidate_changed" });
  });

  it("新方式の候補（#4495）は、同じPRで進んだrevisionを後継として追う", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: { ...openCandidate, headSha: "head2" },
      series: series({ status: "reverifying", successorPrNumber: 10, successorHeadSha: "head2", successorBaseSha: "base1" }),
      checks: null,
    });
    expect(decision).toEqual({ action: "follow_successor", prNumber: 10, headSha: "head2", baseSha: "base1" });
  });

  it("新方式の候補で取り込み中にheadが進んでも、系列が記録するまで止めずに待つ", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: { ...openCandidate, headSha: "head2" },
      series: series({ status: "rebuilding" }),
      checks: null,
    });
    expect(decision).toEqual({ action: "wait", status: "checking" });
  });

  it("作り直しの最中（後継の作成待ち）は、閉じた候補でも待つ", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: { ...openCandidate, state: "closed" },
      series: series({ status: "rebuilding" }),
      checks: null,
    });
    expect(decision).toEqual({ action: "wait", status: "checking" });
  });

  it("再検証で指摘が残った停止は、次の世代を起案する", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: openCandidate,
      series: series({ status: "stopped", stopReason: `後継候補 #10 ${REVERIFY_FAILED_MARKER}（世代 1）。`, successorPrNumber: 10 }),
      checks: { ...passed, aiReview: "failed", findingCount: 2 },
    });
    expect(decision).toEqual({ action: "create_fix", sourceKind: "review_finding" });
  });

  it("準備の失敗など、それ以外の停止は人へ渡す", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: openCandidate,
      series: series({ status: "stopped", stopReason: "候補の作り直しに失敗しました" }),
      checks: { ...passed, aiReview: "failed", findingCount: 1 },
    });
    expect(decision).toMatchObject({ action: "stop", reason: "fix_stopped" });
  });

  it("修正PRを足せない（取り込み済みの可能性）は、修正系列の再評価を待つ（#4452）", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: openCandidate,
      series: series({ status: "stopped", stopReason: NOTHING_TO_ADD_REASON }),
      checks: { ...passed, aiReview: "failed", findingCount: 1 },
    });
    expect(decision).toEqual({ action: "wait", status: "awaiting_decision", note: NOTHING_TO_ADD_REASON });
  });

  it("統合検証の実行障害は修正Issueを作らず止める", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: openCandidate,
      series: null,
      checks: { ...passed, integration: "failed", integrationFailureKind: "execution" },
    });
    expect(decision).toEqual({ action: "stop", reason: "execution_failure" });
  });

  it("指摘の無い全体レビューの失敗（実行障害）は起案しない", () => {
    const decision = decideReleaseCompletion(run(), { now, candidate: openCandidate, series: null, checks: { ...passed, aiReview: "failed" } });
    expect(decision).toEqual({ action: "stop", reason: "execution_failure" });
  });

  it("未実施・実行中・古い結果・Macの未記録は合格にしない", () => {
    for (const checks of [
      { ...passed, integration: "not_run" as const },
      { ...passed, aiReview: "pending" as const },
      { ...passed, aiReview: "invalidated" as const },
      { ...passed, mac: "not_recorded" as const },
    ]) {
      expect(decideReleaseCompletion(run(), { now, candidate: openCandidate, series: null, checks })).toEqual({ action: "wait", status: "checking" });
    }
    expect(decideReleaseCompletion(run(), { now, candidate: openCandidate, series: null, checks: null })).toEqual({ action: "wait", status: "checking" });
  });

  it("全部合格: チェック通過までの系列は本番承認待ち、本番まで許可した系列はマージの判定へ", () => {
    expect(decideReleaseCompletion(run({ scope: "until_ready" }), { now, candidate: openCandidate, series: null, checks: passed })).toEqual({
      action: "wait",
      status: "awaiting_approval",
    });
    expect(decideReleaseCompletion(run(), { now, candidate: openCandidate, series: null, checks: passed })).toEqual({ action: "evaluate_merge" });
  });

  it("記録した候補がマージされたら本番反映の追跡へ。HEADが違えば追わない", () => {
    const merged = { ...openCandidate, state: "closed" as const, merged: true, mergeCommitSha: "m1" };
    expect(decideReleaseCompletion(run({ status: "awaiting_approval" }), { now, candidate: merged, series: null, checks: null })).toEqual({
      action: "begin_release",
      mergeSha: "m1",
    });
    expect(
      decideReleaseCompletion(run({ status: "awaiting_approval" }), { now, candidate: { ...merged, headSha: "x" }, series: null, checks: null }),
    ).toMatchObject({ action: "stop", reason: "candidate_changed" });
  });

  it("期限切れ・停止後は何もしない（停止は書き込みも行わない）", () => {
    expect(decideReleaseCompletion(run({ expiresAt: now }), { now, candidate: openCandidate, series: null, checks: passed })).toEqual({
      action: "stop",
      reason: "timed_out",
    });
    expect(decideReleaseCompletion(run({ status: "stopped", stoppedAt: now }), { now, candidate: openCandidate, series: series(), checks: passed })).toEqual({
      action: "wait",
    });
  });
});

describe("decideCompletionMerge", () => {
  const base: CompletionMergeObservation = {
    now,
    pullRequest: {
      number: 10,
      state: "open",
      merged: false,
      baseRef: "main",
      headRef: "release-main/v1.2.3",
      headSha: "head1",
      baseSha: "base1",
      mergeable: true,
      labels: [],
    },
    mainSha: "base1",
    gateStatus: "ready",
    gateReasons: [],
    macOk: true,
    ciState: "success",
  };
  const merging = run({ status: "merging" });

  it("権限・候補・検証・CIがすべて揃ったときだけ、記録したHEADでマージする", () => {
    expect(decideCompletionMerge(merging, base)).toEqual({ action: "merge", expectedHeadSha: "head1" });
  });

  it("本番まで許可していない系列はマージしない", () => {
    expect(decideCompletionMerge(run({ scope: "until_ready" }), base)).toEqual({ action: "stop", reason: "scope_not_allowed" });
  });

  it("停止・期限・費用上限ではマージしない", () => {
    expect(decideCompletionMerge(run({ stoppedAt: now }), base)).toMatchObject({ action: "stop", reason: "stopped_by_user" });
    expect(decideCompletionMerge(run({ expiresAt: now }), base)).toMatchObject({ action: "stop", reason: "timed_out" });
    expect(decideCompletionMerge(run({ costUsedUsd: 31 }), base)).toMatchObject({ action: "stop", reason: "cost_limit" });
  });

  it("mainが進んだ・HEADが動いた・別のPRではマージしない", () => {
    expect(decideCompletionMerge(merging, { ...base, mainSha: "base2" })).toMatchObject({ action: "stop", reason: "base_changed" });
    expect(decideCompletionMerge(merging, { ...base, pullRequest: { ...base.pullRequest!, headSha: "x" } })).toMatchObject({
      action: "stop",
      reason: "candidate_changed",
    });
    expect(decideCompletionMerge(merging, { ...base, pullRequest: { ...base.pullRequest!, headRef: "develop" } })).toMatchObject({
      action: "stop",
      reason: "candidate_changed",
    });
  });

  it("要確認・未完了の検証、Mac未合格、CI待ちは待つだけで権限を与えない", () => {
    expect(decideCompletionMerge(merging, { ...base, gateStatus: "needs_confirmation", gateReasons: ["要確認"] }).action).toBe("wait");
    expect(decideCompletionMerge(merging, { ...base, gateStatus: "blocked" }).action).toBe("wait");
    expect(decideCompletionMerge(merging, { ...base, macOk: false }).action).toBe("wait");
    expect(decideCompletionMerge(merging, { ...base, ciState: "pending" }).action).toBe("wait");
    expect(decideCompletionMerge(merging, { ...base, ciState: "failure" })).toEqual({ action: "stop", reason: "ci_failed" });
  });

  it("人の確認を求めるラベル・コンフリクトでは止める", () => {
    expect(decideCompletionMerge(merging, { ...base, pullRequest: { ...base.pullRequest!, labels: ["22.merge-confirm-required"] } })).toMatchObject({
      action: "stop",
      reason: "blocked_by_label",
    });
    expect(decideCompletionMerge(merging, { ...base, pullRequest: { ...base.pullRequest!, mergeable: false } })).toMatchObject({
      action: "stop",
      reason: "base_changed",
    });
  });
});

describe("releaseCompletionStageIndex", () => {
  it("6段階の位置を返し、引き継いだ本番復旧は本番反映以降として扱う", () => {
    expect(releaseCompletionStageIndex("investigating")).toBe(0);
    expect(releaseCompletionStageIndex("fixing")).toBe(1);
    expect(releaseCompletionStageIndex("awaiting_approval")).toBe(2);
    expect(releaseCompletionStageIndex("releasing")).toBe(3);
    expect(releaseCompletionStageIndex("verifying")).toBe(4);
    expect(releaseCompletionStageIndex("completed")).toBe(5);
    expect(releaseCompletionStageIndex("deploy_recovery", 0)).toBe(3);
    expect(releaseCompletionStageIndex("deploy_recovery", 4)).toBe(4);
    expect(releaseCompletionStageIndex("needs_attention")).toBe(-1);
  });
});
