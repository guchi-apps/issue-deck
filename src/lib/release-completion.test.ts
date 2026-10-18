import { describe, expect, it } from "vitest";

import {
  APPROVAL_RETRYABLE_STOP_REASONS,
  decideCompletionMerge,
  decideReleaseCompletion,
  describeMergeWait,
  describeUnverifiedReview,
  reevaluationKeepsWaiting,
  releaseCompletionStopMessage,
  isLongMergeWait,
  nextMergeWait,
  RELEASE_COMPLETION_LONG_WAIT_MS,
  isAiReviewWaivedFor,
  isGateClearedByReviewDecisions,
  waiveAiReviewCheck,
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

  it("旧3世代上限で止まった系列も、次の世代を起案する（#4589）", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: openCandidate,
      series: series({ status: "stopped", stopReason: "修正の反復が上限（3回）に達しました。原因を人が整理してから進めてください", successorPrNumber: 10 }),
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

  it("要確認がユーザーの判断で解除できるものだけなら、他の条件が揃えばマージする（#4657）", () => {
    const decided = { ...base, gateStatus: "needs_confirmation" as const, gateReasons: ["要確認"], gateClearedByDecision: true };
    expect(decideCompletionMerge(merging, decided)).toEqual({ action: "merge", expectedHeadSha: "head1" });
    // 判断で解除しても、Mac・CI・本番まで許可した範囲の条件は変わらない
    expect(decideCompletionMerge(merging, { ...decided, macOk: false }).action).toBe("wait");
    expect(decideCompletionMerge(merging, { ...decided, ciState: "pending" }).action).toBe("wait");
    expect(decideCompletionMerge(run({ scope: "until_ready" }), decided)).toEqual({ action: "stop", reason: "scope_not_allowed" });
    expect(decideCompletionMerge(merging, { ...base, gateStatus: "blocked", gateClearedByDecision: true }).action).toBe("wait");
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

describe("公開準備（正式バンプ。#4496）との接続", () => {
  const finalized = { phase: "awaiting_approval", applied: { preHeadSha: "head1", finalHeadSha: "head2", finalBaseSha: "base1" } };

  it("記録したバンプ前→バンプ後のheadの更新だけを後継として追う", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: { ...openCandidate, headSha: "head2" },
      series: null,
      checks: passed,
      finalization: finalized,
    });
    expect(decision).toEqual({ action: "follow_successor", prNumber: 10, headSha: "head2", baseSha: "base1" });
  });

  it("バンプとして記録していないhead変更は、従来どおり候補の変更として止める", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: { ...openCandidate, headSha: "other" },
      series: null,
      checks: passed,
      finalization: finalized,
    });
    expect(decision).toMatchObject({ action: "stop", reason: "candidate_changed" });
    // バンプ前のheadが系列の記録と違う（別のバンプ）場合も追わない
    const otherBase = decideReleaseCompletion(run({ candidateHeadSha: "head0" }), {
      now,
      candidate: { ...openCandidate, headSha: "head2" },
      series: null,
      checks: passed,
      finalization: finalized,
    });
    expect(otherBase).toMatchObject({ action: "stop", reason: "candidate_changed" });
  });

  it("新方式の候補は、公開準備と最終検証が済むまで承認待ち・マージ評価へ進めない", () => {
    const notReady = { phase: "review", applied: null };
    expect(decideReleaseCompletion(run(), { now, candidate: openCandidate, series: null, checks: passed, finalization: notReady })).toMatchObject({
      action: "wait",
      status: "awaiting_approval",
    });
    const preparing = { phase: "preparing", applied: { preHeadSha: "h0", finalHeadSha: "head1", finalBaseSha: "base1" } };
    expect(decideReleaseCompletion(run(), { now, candidate: openCandidate, series: null, checks: passed, finalization: preparing }).action).toBe("wait");
    const ready = { phase: "awaiting_approval", applied: { preHeadSha: "h0", finalHeadSha: "head1", finalBaseSha: "base1" } };
    expect(decideReleaseCompletion(run(), { now, candidate: openCandidate, series: null, checks: passed, finalization: ready })).toEqual({ action: "evaluate_merge" });
  });

  describe("修正系列→正式バンプ→公開承認（#4729）", () => {
    // 修正系列がrevision 2（rev2）を作り、その後の公開準備でrevision 3（rev3）へバンプした
    const bumped = { phase: "awaiting_approval", applied: { preHeadSha: "rev2", finalHeadSha: "rev3", finalBaseSha: "base1" } };
    const fixed = series({ status: "ready", successorPrNumber: 10, successorHeadSha: "rev2", successorBaseSha: "base1" });
    const bumpedCandidate = { ...openCandidate, headSha: "rev3" };

    /** 巡回を繰り返し、`follow_successor`は系列の記録へ反映する（`applyDecision`と同じ） */
    function sweep(start: ReleaseCompletionState, rounds: number) {
      let state = start;
      const decisions = [];
      for (let i = 0; i < rounds; i++) {
        const decision = decideReleaseCompletion(state, { now, candidate: bumpedCandidate, series: fixed, checks: passed, finalization: bumped });
        decisions.push(decision);
        if (decision.action === "follow_successor") {
          state = { ...state, candidatePrNumber: decision.prNumber, candidateHeadSha: decision.headSha, candidateBaseSha: decision.baseSha };
        }
      }
      return { state, decisions };
    }

    it("バンプ前のheadを記録した系列は、バンプ後へ1回進んだあと往復せずマージ評価へ届く", () => {
      const { state, decisions } = sweep(run({ candidateHeadSha: "rev2", fromPublishApproval: true }), 3);
      expect(decisions.map((d) => d.action)).toEqual(["follow_successor", "evaluate_merge", "evaluate_merge"]);
      expect(state.candidateHeadSha).toBe("rev3");
    });

    it("バンプ後のheadを記録済みの系列は、バンプ前の後継へ戻らない", () => {
      const { state, decisions } = sweep(run({ candidateHeadSha: "rev3", fromPublishApproval: true }), 2);
      expect(decisions.map((d) => d.action)).toEqual(["evaluate_merge", "evaluate_merge"]);
      expect(state.candidateHeadSha).toBe("rev3");
    });

    it("バンプ後に修正系列が新しいrevisionを作ったら、従来どおり後継として追う", () => {
      const decision = decideReleaseCompletion(run({ candidateHeadSha: "rev3" }), {
        now,
        candidate: { ...openCandidate, headSha: "rev4" },
        series: { ...fixed, successorHeadSha: "rev4" },
        checks: passed,
        finalization: bumped,
      });
      expect(decision).toEqual({ action: "follow_successor", prNumber: 10, headSha: "rev4", baseSha: "base1" });
    });
  });

  it("旧方式の候補（公開準備なし）は従来どおり評価へ進む", () => {
    expect(decideReleaseCompletion(run(), { now, candidate: openCandidate, series: null, checks: passed })).toEqual({ action: "evaluate_merge" });
  });

  it("マージ直前も、最終検証に合格したバンプ後のheadでなければ待つ", () => {
    const observation: CompletionMergeObservation = {
      now,
      pullRequest: { number: 10, state: "open", merged: false, baseRef: "main", headRef: "release-rc/3", headSha: "head1", baseSha: "base1", mergeable: true, labels: [] },
      mainSha: "base1",
      gateStatus: "ready",
      gateReasons: [],
      macOk: true,
      ciState: "success",
    };
    const merging = run({ status: "merging" });
    expect(decideCompletionMerge(merging, { ...observation, finalization: { phase: "review", applied: null } })).toEqual({ action: "wait", reason: "finalization_not_ready" });
    expect(
      decideCompletionMerge(merging, { ...observation, finalization: { phase: "preparing", applied: { preHeadSha: "h0", finalHeadSha: "head1", finalBaseSha: "base1" } } }),
    ).toEqual({ action: "wait", reason: "finalization_not_ready" });
    expect(
      decideCompletionMerge(merging, { ...observation, finalization: { phase: "awaiting_approval", applied: { preHeadSha: "h0", finalHeadSha: "head1", finalBaseSha: "base1" } } }),
    ).toEqual({ action: "merge", expectedHeadSha: "head1" });
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

describe("指摘ごとのユーザー判断（#4657）", () => {
  const decided: CompletionChecks = { ...passed, aiReview: "needs_check", findingCount: 2 };

  it("止める指摘の全件が修正しない判断なら、新たな修正を起案しない", () => {
    const observe = (checks: CompletionChecks) => decideReleaseCompletion(run(), { now, candidate: openCandidate, series: null, checks });
    expect(observe(decided)).toEqual({ action: "create_fix", sourceKind: "review_finding" });
    expect(observe({ ...decided, aiReviewClearedByDecision: true }).action).not.toBe("create_fix");
  });

  it("判断済みでも統合検証の失敗は従来どおり起案する", () => {
    const decision = decideReleaseCompletion(run(), {
      now,
      candidate: openCandidate,
      series: null,
      checks: { ...decided, aiReviewClearedByDecision: true, integration: "failed", integrationFailureKind: "code" },
    });
    expect(decision).toEqual({ action: "create_fix", sourceKind: "integration_failure" });
  });

  it("判断で解除できるのは全体レビューの要確認だけ", () => {
    const aiOnly = [{ kind: "ai_review", state: "needs_check" }];
    expect(isGateClearedByReviewDecisions({ gateStatus: "needs_confirmation", blockers: aiOnly, aiReviewCleared: true })).toBe(true);
    expect(isGateClearedByReviewDecisions({ gateStatus: "needs_confirmation", blockers: aiOnly, aiReviewCleared: false })).toBe(false);
    expect(
      isGateClearedByReviewDecisions({
        gateStatus: "needs_confirmation",
        blockers: [...aiOnly, { kind: "integration", state: "needs_check" }],
        aiReviewCleared: true,
      }),
    ).toBe(false);
    // 実行中・失敗・古い結果（blocked）は判断では解除しない
    expect(isGateClearedByReviewDecisions({ gateStatus: "blocked", blockers: [{ kind: "integration", state: "running" }], aiReviewCleared: true })).toBe(false);
  });
});

describe("公開承認（#4666）から始めた系列", () => {
  const approvalRun = (overrides: Partial<ReleaseCompletionState> = {}) => run({ status: "checking", fromPublishApproval: true, ...overrides });
  const preparing = { phase: "preparing", applied: null, latest: { status: "requested", failureReason: null } };

  it("正式バンプと最終検証の間は、承認待ちにせず最終検証中として待つ", () => {
    const decision = decideReleaseCompletion(approvalRun(), { now, candidate: openCandidate, series: null, checks: passed, finalization: preparing });
    expect(decision).toMatchObject({ action: "wait", status: "checking" });
  });

  it("最終検証に合格したら、追加の承認なしでマージの判定へ進む", () => {
    const decision = decideReleaseCompletion(approvalRun({ candidateHeadSha: "head2" }), {
      now,
      candidate: { ...openCandidate, headSha: "head2" },
      series: null,
      checks: passed,
      finalization: { phase: "awaiting_approval", applied: { preHeadSha: "head1", finalHeadSha: "head2", finalBaseSha: "base1" } },
    });
    expect(decision).toEqual({ action: "evaluate_merge" });
  });

  it("検証の失敗では修正Issueを起案せず、理由を示して止める", () => {
    const decision = decideReleaseCompletion(approvalRun(), {
      now,
      candidate: openCandidate,
      series: null,
      checks: { ...passed, integration: "failed", integrationFailureKind: "code" },
      finalization: preparing,
    });
    expect(decision).toEqual({ action: "stop", reason: "approval_checks_failed", detail: "統合検証" });
  });

  it("未判断の止める指摘は判断待ちとして止め、#4657の判断があれば止めない", () => {
    const undecided = { ...passed, aiReview: "needs_check" as const, findingCount: 2 };
    expect(decideReleaseCompletion(approvalRun(), { now, candidate: openCandidate, series: null, checks: undecided, finalization: preparing })).toEqual({
      action: "stop",
      reason: "approval_review_undecided",
      detail: "2件",
    });
    expect(
      decideReleaseCompletion(approvalRun(), { now, candidate: openCandidate, series: null, checks: { ...undecided, aiReviewClearedByDecision: true }, finalization: preparing }),
    ).toMatchObject({ action: "wait", status: "checking" });
  });

  it("全体レビューを承知で外した公開準備では、指摘・失敗で止めず公開準備の完了を待つ（#4807）", () => {
    const waiver = { ...preparing, aiReviewWaiver: { preHeadSha: "head1", finalHeadSha: null } };
    expect(isAiReviewWaivedFor(waiver, "head1")).toBe(true);
    expect(isAiReviewWaivedFor(waiver, "other")).toBe(false);
    expect(isAiReviewWaivedFor(preparing, "head1")).toBe(false);
    const failedReview = { ...passed, aiReview: "failed" as const };
    expect(decideReleaseCompletion(approvalRun(), { now, candidate: openCandidate, series: null, checks: failedReview, finalization: waiver })).toMatchObject({
      action: "stop",
    });
    const checks = waiveAiReviewCheck(failedReview, isAiReviewWaivedFor(waiver, openCandidate.headSha));
    expect(decideReleaseCompletion(approvalRun(), { now, candidate: openCandidate, series: null, checks, finalization: waiver })).toMatchObject({
      action: "wait",
      status: "checking",
    });
    // 統合検証の失敗は外さない
    const integrationFailed = waiveAiReviewCheck({ ...failedReview, integration: "failed", integrationFailureKind: "code" }, true);
    expect(decideReleaseCompletion(approvalRun(), { now, candidate: openCandidate, series: null, checks: integrationFailed, finalization: waiver })).toEqual({
      action: "stop",
      reason: "approval_checks_failed",
      detail: "統合検証",
    });
  });

  it("公開準備が失敗して修正工程へ戻ったら、理由を示して止める", () => {
    const decision = decideReleaseCompletion(approvalRun(), {
      now,
      candidate: openCandidate,
      series: null,
      checks: passed,
      finalization: { phase: "review", applied: null, latest: { status: "failed", failureReason: "リリースworkflowを起動できませんでした" } },
    });
    expect(decision).toEqual({ action: "stop", reason: "finalize_failed", detail: "リリースworkflowを起動できませんでした" });
  });

  it("修正Issueを起動しない", () => {
    const decision = decideReleaseCompletion(approvalRun(), { now, candidate: openCandidate, series: series(), checks: null, finalization: preparing });
    expect(decision).toEqual({ action: "wait", status: "fixing", note: null });
  });

  it("承認が有効でなければマージしない", () => {
    const observation: CompletionMergeObservation = {
      now,
      finalization: { phase: "awaiting_approval", applied: { preHeadSha: "head0", finalHeadSha: "head1", finalBaseSha: "base1" } },
      pullRequest: { number: 10, state: "open", merged: false, baseRef: "main", headRef: "release-rc/3", headSha: "head1", baseSha: "base1", mergeable: true, labels: [] },
      mainSha: "base1",
      gateStatus: "ready",
      gateReasons: [],
      macOk: true,
      ciState: "success",
    };
    const merging = run({ status: "merging", fromPublishApproval: true });
    expect(decideCompletionMerge(merging, { ...observation, publishApprovalValid: true })).toEqual({ action: "merge", expectedHeadSha: "head1" });
    expect(decideCompletionMerge(merging, { ...observation, publishApprovalValid: false })).toEqual({ action: "stop", reason: "approval_invalidated" });
    // 保護・必須チェック・人の確認ラベルは承認があっても迂回しない
    expect(decideCompletionMerge(merging, { ...observation, publishApprovalValid: true, ciState: "pending" })).toMatchObject({ action: "wait" });
    expect(
      decideCompletionMerge(merging, { ...observation, publishApprovalValid: true, pullRequest: { ...observation.pullRequest!, labels: ["22.merge-confirm-required"] } }),
    ).toMatchObject({ action: "stop", reason: "blocked_by_label" });
  });
});

describe("本番マージの待ち理由（#4725）", () => {
  const t0 = new Date("2026-10-18T03:00:00Z");

  it("理由コードを日本語1行にし、未知の理由（検証ゲートの文言）は添えて出す", () => {
    expect(describeMergeWait(null)).toBeNull();
    expect(describeMergeWait("mergeable_unknown")).toBe("GitHubのマージ可否を判定中");
    expect(describeMergeWait("ci_pending")).toBe("CIの完了を待っています");
    expect(describeMergeWait("finalization_not_ready")).toContain("公開準備");
    expect(describeMergeWait("統合検証: 対象が変わったため古い結果は使えません")).toBe("検証の条件を待っています: 統合検証: 対象が変わったため古い結果は使えません");
  });

  it("理由が変わったとき（初回を含む）だけ待ち始めを更新する", () => {
    expect(nextMergeWait({ reason: null, since: null }, "ci_pending", t0)).toEqual({ reason: "ci_pending", since: t0 });
    expect(nextMergeWait({ reason: "ci_pending", since: t0 }, "ci_pending", new Date(t0.getTime() + 60_000))).toBeNull();
    const later = new Date(t0.getTime() + 60_000);
    expect(nextMergeWait({ reason: "ci_pending", since: t0 }, "mergeable_unknown", later)).toEqual({ reason: "mergeable_unknown", since: later });
  });

  it("同じ理由で15分以上待つと長時間待ち（境界を含む）", () => {
    expect(isLongMergeWait(null, t0)).toBe(false);
    expect(isLongMergeWait(t0, new Date(t0.getTime() + RELEASE_COMPLETION_LONG_WAIT_MS - 1))).toBe(false);
    expect(isLongMergeWait(t0, new Date(t0.getTime() + RELEASE_COMPLETION_LONG_WAIT_MS))).toBe(true);
  });
});

describe("指摘0件で未確認範囲だけの全体レビュー（#4768）", () => {
  const unverified = (stage: "reevaluating" | "settled", detail: string | null = "コードの未確認範囲"): CompletionChecks => ({
    ...passed,
    aiReview: "needs_check",
    findingCount: 0,
    aiReviewUnverified: { stage, detail },
  });
  const decide = (checks: CompletionChecks, overrides: Partial<ReleaseCompletionState> = {}) =>
    decideReleaseCompletion(run({ status: "checking", ...overrides }), { now, candidate: openCandidate, series: null, checks });

  it("統合検証が終わっていなければ、実行障害にせず待つ", () => {
    for (const integration of ["pending", "not_run", "invalidated"] as const) {
      expect(decide({ ...unverified("reevaluating"), integration })).toMatchObject({ action: "wait", status: "checking" });
      expect(decide({ ...unverified("settled"), integration })).toMatchObject({ action: "wait", status: "checking" });
    }
  });

  it("統合検証が終わっていて再評価がまだなら、再評価を積む", () => {
    expect(decide(unverified("reevaluating"))).toEqual({ action: "reevaluate_review" });
  });

  it("再評価でも残った（再評価で変わらない）ときは、理由を示して止める。「実行障害」とはしない", () => {
    const decision = decide(unverified("settled", "証跡に依存しない未確認の確認項目"));
    expect(decision).toEqual({ action: "stop", reason: "review_unverified", detail: "証跡に依存しない未確認の確認項目" });
    const message = releaseCompletionStopMessage("review_unverified", "証跡に依存しない未確認の確認項目") ?? "";
    expect(message).toContain("確認できなかった範囲が残った");
    expect(message).not.toContain("実行障害");
    // 段階が分からない旧い観測も、再評価済みとして同じ理由で止める（修正Issueは起案しない）
    expect(decide({ ...passed, aiReview: "needs_check", findingCount: 0 })).toMatchObject({ action: "stop", reason: "review_unverified" });
  });

  it("公開承認の系列も同じ扱いで、承認を失効させない理由で止める", () => {
    expect(decide(unverified("reevaluating"), { fromPublishApproval: true })).toEqual({ action: "reevaluate_review" });
    expect(decide(unverified("settled"), { fromPublishApproval: true })).toMatchObject({ action: "stop", reason: "review_unverified" });
    expect(APPROVAL_RETRYABLE_STOP_REASONS.has("review_unverified")).toBe(true);
  });

  it("統合検証の失敗が同時にあれば、従来どおり統合検証の失敗として扱う", () => {
    expect(decide({ ...unverified("settled"), integration: "failed", integrationFailureKind: "code" })).toEqual({
      action: "create_fix",
      sourceKind: "integration_failure",
    });
    expect(decide({ ...unverified("settled"), integration: "failed", integrationFailureKind: "execution" })).toEqual({
      action: "stop",
      reason: "execution_failure",
    });
  });

  it("指摘のある要確認・指摘の無い失敗は従来どおり", () => {
    expect(decide({ ...passed, aiReview: "needs_check", findingCount: 1 })).toEqual({ action: "create_fix", sourceKind: "review_finding" });
    expect(decide({ ...passed, aiReview: "failed", findingCount: 0 })).toEqual({ action: "stop", reason: "execution_failure" });
  });

  it("段階は画面と同じ規則から読み、止めるときの内容に未確認の種類と範囲を添える", () => {
    expect(describeUnverifiedReview({ state: "needs_check", findingCount: 0, stage: { kind: "reevaluating" }, unverifiedScope: "x" })).toEqual({
      stage: "reevaluating",
      detail: "x",
    });
    expect(
      describeUnverifiedReview({
        state: "needs_check",
        findingCount: 0,
        stage: { kind: "needs_check", autoReevaluated: true, items: ["code_unread"] },
        unverifiedScope: "差分3ファイルのうち2ファイルを確認済み（未確認1）",
      }),
    ).toEqual({ stage: "settled", detail: "コードの未確認範囲：差分3ファイルのうち2ファイルを確認済み（未確認1）" });
    expect(describeUnverifiedReview({ state: "needs_check", findingCount: 2, stage: null, unverifiedScope: null })).toBeNull();
    expect(describeUnverifiedReview({ state: "passed", findingCount: 0, stage: null, unverifiedScope: null })).toBeNull();
  });

  it("再評価を積めた・実行中・ホスト待ちなら待ち、積めない理由なら止める", () => {
    expect(reevaluationKeepsWaiting({ action: "rerun" })).toBe(true);
    expect(reevaluationKeepsWaiting({ action: "none", reason: "review_active" })).toBe(true);
    expect(reevaluationKeepsWaiting({ action: "none", reason: "review_in_progress" })).toBe(true);
    expect(reevaluationKeepsWaiting({ action: "skipped", reason: "no_host" })).toBe(true);
    expect(reevaluationKeepsWaiting({ action: "none", reason: "no_evidence_dependency" })).toBe(false);
    expect(reevaluationKeepsWaiting({ action: "none", reason: "already_reevaluated" })).toBe(false);
    expect(reevaluationKeepsWaiting({ action: "skipped", reason: "no_verify_host" })).toBe(false);
    expect(reevaluationKeepsWaiting({ action: "fail_stalled" })).toBe(false);
  });
});
