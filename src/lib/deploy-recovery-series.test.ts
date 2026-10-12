import { describe, expect, it } from "vitest";

import {
  decideDeployRecovery,
  decideDeployRecoveryRelease,
  deployFailureKey,
  deployRecoveryStage,
  DEPLOY_RECOVERY_MAX_RELEASE_ATTEMPTS,
  parseDeployRecoveryFixPullRequest,
  DEPLOY_RECOVERY_RELEASE_TIMEOUT_MS,
  DEPLOY_RECOVERY_RETRY_WAIT_MS,
  type DeployRunObservation,
  DEPLOY_RECOVERY_CAUSE_TIMEOUT_MS,
  DEPLOY_RECOVERY_MAX_REPAIR_ROUNDS,
  deployRecoveryStatusLabel,
  isDeployRecoveryActive,
  parseDeployRecoveryCause,
  type DeployRecoveryObservation,
  type DeployRecoverySeriesState,
} from "./deploy-recovery-series";

const now = new Date("2026-10-05T12:00:00Z");
const series = (overrides: Partial<DeployRecoverySeriesState> = {}): DeployRecoverySeriesState => ({
  status: "investigating",
  scope: "fix_until_develop",
  expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
  dispatchedAt: new Date(now.getTime() - 60 * 1000),
  cause: null,
  pullRequestNumber: null,
  repairRoundsBase: 0,
  ...overrides,
});
const observed = (overrides: Partial<DeployRecoveryObservation> = {}): DeployRecoveryObservation => ({
  now,
  reportedCause: null,
  pullRequest: null,
  repairLoop: null,
  ...overrides,
});
const openPr = { number: 12, state: "open" as const, merged: false };

describe("decideDeployRecovery", () => {
  it("原因の区分が報告されるまで待ち、時間を過ぎたら止める", () => {
    expect(decideDeployRecovery(series(), observed())).toEqual({ action: "wait" });
    const late = series({ dispatchedAt: new Date(now.getTime() - DEPLOY_RECOVERY_CAUSE_TIMEOUT_MS) });
    expect(decideDeployRecovery(late, observed())).toEqual({ action: "stop", reason: "cause_not_reported" });
  });

  it("コード以外の区分では、PRが出ていても修正へ進めない", () => {
    for (const cause of ["config", "database", "external", "unknown"] as const) {
      expect(decideDeployRecovery(series(), observed({ reportedCause: cause, pullRequest: openPr }))).toEqual({
        action: "stop",
        reason: "non_code_cause",
        detail: cause,
      });
    }
  });

  it("コードの区分なら修正中へ進み、PRが出たらCI・レビュー待ちへ進む", () => {
    expect(decideDeployRecovery(series(), observed({ reportedCause: "code" }))).toEqual({
      action: "transition",
      status: "fixing",
      cause: "code",
    });
    expect(decideDeployRecovery(series({ status: "fixing" }), observed())).toEqual({ action: "wait" });
    expect(decideDeployRecovery(series({ status: "fixing" }), observed({ pullRequest: openPr }))).toEqual({
      action: "transition",
      status: "awaiting_checks",
      pullRequestNumber: 12,
    });
  });

  it("修正PRを残り回数つきで修復系列へ渡し、系列全体の上限を超えない", () => {
    const waiting = series({ status: "awaiting_checks", pullRequestNumber: 12 });
    expect(decideDeployRecovery(waiting, observed({ pullRequest: openPr }))).toEqual({
      action: "enroll_repair",
      pullRequestNumber: 12,
      maxRounds: DEPLOY_RECOVERY_MAX_REPAIR_ROUNDS,
    });
    expect(
      decideDeployRecovery({ ...waiting, repairRoundsBase: 2 }, observed({ pullRequest: openPr })),
    ).toMatchObject({ action: "enroll_repair", maxRounds: 1 });
    expect(
      decideDeployRecovery({ ...waiting, repairRoundsBase: DEPLOY_RECOVERY_MAX_REPAIR_ROUNDS }, observed({ pullRequest: openPr })),
    ).toEqual({ action: "stop", reason: "max_rounds_reached" });
  });

  it("修復系列が止まったら要対応、進行中・完了なら待つ", () => {
    const waiting = series({ status: "awaiting_checks", pullRequestNumber: 12 });
    const loop = (status: string, round: number, stopReason: string | null = null) => ({ status, round, stopReason });
    expect(decideDeployRecovery(waiting, observed({ pullRequest: openPr, repairLoop: loop("running", 1) }))).toEqual({ action: "wait" });
    expect(decideDeployRecovery(waiting, observed({ pullRequest: openPr, repairLoop: loop("completed", 1) }))).toEqual({ action: "wait" });
    expect(
      decideDeployRecovery(waiting, observed({ pullRequest: openPr, repairLoop: loop("stopped", 1, "user_action_required") })),
    ).toEqual({ action: "stop", reason: "repair_stopped", detail: "user_action_required" });
    expect(
      decideDeployRecovery(waiting, observed({ pullRequest: openPr, repairLoop: loop("stopped", 3, "max_rounds_reached") })),
    ).toEqual({ action: "stop", reason: "max_rounds_reached" });
  });

  it("修正PRのマージは本番反映待ちで止まり、復旧済みにはしない（第1段）", () => {
    const waiting = series({ status: "awaiting_checks", pullRequestNumber: 12 });
    const merged = observed({ pullRequest: { number: 12, state: "closed", merged: true } });
    expect(decideDeployRecovery(waiting, merged)).toEqual({ action: "transition", status: "awaiting_release" });
    expect(isDeployRecoveryActive("awaiting_release")).toBe(false);
    // mainまでの許可を開始者が出した系列だけが、復旧PRの工程へ進む（#4006）
    expect(decideDeployRecovery(series({ status: "awaiting_checks", scope: "fix_until_main", pullRequestNumber: 12 }), merged)).toEqual({
      action: "transition",
      status: "awaiting_main_merge",
    });
    // 本番反映待ちからは巡回が何を観測しても進めない
    expect(decideDeployRecovery(series({ status: "awaiting_release" }), merged)).toEqual({ action: "wait" });
  });

  it("マージされずに閉じたPRは止める", () => {
    const waiting = series({ status: "awaiting_checks", pullRequestNumber: 12 });
    expect(
      decideDeployRecovery(waiting, observed({ pullRequest: { number: 12, state: "closed", merged: false } })),
    ).toEqual({ action: "stop", reason: "pull_request_closed" });
  });

  it("期限を過ぎたらどの段階でも止め、終わった系列は動かさない", () => {
    const expired = { expiresAt: new Date(now.getTime() - 1) };
    expect(decideDeployRecovery(series({ ...expired, status: "awaiting_checks" }), observed())).toEqual({ action: "stop", reason: "timed_out" });
    expect(decideDeployRecovery(series({ ...expired, status: "stopped" }), observed())).toEqual({ action: "wait" });
    expect(decideDeployRecovery(series({ status: "needs_attention" }), observed({ reportedCause: "code" }))).toEqual({ action: "wait" });
  });

  it("開始・準備中は外部操作側が進めるため判断しない", () => {
    expect(decideDeployRecovery(series({ status: "starting" }), observed({ reportedCause: "code" }))).toEqual({ action: "wait" });
    expect(decideDeployRecovery(series({ status: "preparing" }), observed({ reportedCause: "code" }))).toEqual({ action: "wait" });
  });
});

describe("parseDeployRecoveryCause", () => {
  it("最後に報告された区分を読み、区分外の値はunknownにする", () => {
    expect(parseDeployRecoveryCause(["調査中", null])).toBeNull();
    expect(
      parseDeployRecoveryCause([
        "<!-- issue-deck-deploy-recovery-cause:unknown -->",
        "調べ直しました\n<!-- issue-deck-deploy-recovery-cause:code -->",
      ]),
    ).toBe("code");
    expect(parseDeployRecoveryCause(["<!-- issue-deck-deploy-recovery-cause:secret -->"])).toBe("unknown");
  });
});

describe("deployRecoveryStatusLabel", () => {
  it("画面の7状態へ寄せる", () => {
    expect(deployRecoveryStatusLabel("preparing")).toBe("調査中");
    expect(deployRecoveryStatusLabel("awaiting_checks")).toBe("CI・レビュー待ち");
    expect(deployRecoveryStatusLabel("needs_attention")).toBe("要対応");
  });
});

describe("decideDeployRecoveryRelease（#4007）", () => {
  const releaseSha = "a".repeat(40);
  const release = { releaseSha, releaseStartedAt: new Date(now.getTime() - 60 * 1000) };
  const run = (overrides: Partial<DeployRunObservation> = {}): DeployRunObservation => ({
    id: 100,
    htmlUrl: "https://github.com/o/r/actions/runs/100",
    createdAt: new Date(now.getTime() - 30 * 1000).toISOString(),
    headSha: releaseSha,
    status: "completed",
    conclusion: "success",
    attempt: 1,
    ...overrides,
  });
  const decide = (runs: DeployRunObservation[], versionVerified: boolean, at = now, state = release) =>
    decideDeployRecoveryRelease(state, { now: at, runs, versionVerified });
  const later = (ms: number) => new Date(now.getTime() + ms);

  it("対象SHAのrunが無い間は待ち、上限を過ぎたら止める（deployを起動し直さない）", () => {
    expect(decide([], false)).toEqual({ action: "wait" });
    expect(decide([run({ headSha: "b".repeat(40) })], true)).toEqual({ action: "wait" });
    expect(decide([], false, later(DEPLOY_RECOVERY_RELEASE_TIMEOUT_MS))).toEqual({ action: "stop", reason: "deploy_not_started" });
  });

  it("別SHAのdeploy成功では復旧済みにしない", () => {
    expect(decide([run({ headSha: "b".repeat(40) })], true).action).toBe("wait");
  });

  it("進行中は本番反映中として追跡する", () => {
    const r = run({ status: "in_progress", conclusion: null });
    expect(decide([r], false)).toEqual({ action: "track", status: "releasing", run: r });
  });

  it("成功かつ稼働SHAの一致を確かめたときだけ復旧済みにする", () => {
    const r = run();
    expect(decide([r], true)).toEqual({ action: "recovered", run: r });
    // 一致を確かめられない（旧版がHTTP 200を返すだけ・照合の無いworkflow）なら復旧済みにしない
    expect(decide([r], false)).toEqual({ action: "track", status: "verifying", run: r });
  });

  it("確かめられないまま上限を過ぎたら、復旧済みでなく要対応へ渡す", () => {
    expect(decide([run()], false, later(DEPLOY_RECOVERY_RELEASE_TIMEOUT_MS)).action).toBe("stop");
  });

  it("同じSHAのrunが複数あれば最新だけで判断する（重複）", () => {
    const old = run({ id: 1, createdAt: new Date(now.getTime() - 50 * 1000).toISOString(), conclusion: "failure" });
    const fresh = run({ id: 2 });
    expect(decide([old, fresh], true)).toEqual({ action: "recovered", run: fresh });
  });

  it("cancelは再実行を待ち、上限で止める", () => {
    const r = run({ conclusion: "cancelled" });
    expect(decide([r], true)).toEqual({ action: "wait" });
    expect(decide([r], true, later(DEPLOY_RECOVERY_RELEASE_TIMEOUT_MS))).toMatchObject({ action: "stop", reason: "deploy_cancelled" });
  });

  it("1回目の失敗はdeploy-retryの再実行を待ち、再実行も失敗したら同じ系列を調査へ戻す", () => {
    const failed = run({ conclusion: "failure" });
    expect(decide([failed], false)).toEqual({ action: "wait" });
    expect(decide([run({ conclusion: "failure", attempt: 2 })], false)).toMatchObject({ action: "requeue" });
    expect(decide([failed], false, later(DEPLOY_RECOVERY_RETRY_WAIT_MS))).toMatchObject({ action: "requeue" });
  });

  it("本番反映の上限時間を過ぎた失敗は戻さず人へ渡す", () => {
    expect(decide([run({ conclusion: "failure", attempt: 2 })], false, later(DEPLOY_RECOVERY_RELEASE_TIMEOUT_MS))).toMatchObject({
      action: "stop",
      reason: "deploy_failed",
    });
  });

  it("timed_outも失敗として扱う", () => {
    expect(decide([run({ conclusion: "timed_out", attempt: 2 })], false)).toMatchObject({ action: "requeue" });
  });

  it("前回と同じ署名の失敗が続いたら停滞として止める", () => {
    const key = deployFailureKey("failure", ["deploy"]);
    const failed = run({ conclusion: "failure", attempt: 2 });
    const state = { ...release, releaseAttempts: 1, lastFailureKey: key };
    expect(decideDeployRecoveryRelease(state, { now, runs: [failed], versionVerified: false, failureKey: key })).toMatchObject({
      action: "stop",
      reason: "release_stalled",
    });
    // 違う署名なら戻す
    expect(
      decideDeployRecoveryRelease(state, { now, runs: [failed], versionVerified: false, failureKey: deployFailureKey("failure", ["migrate"]) }),
    ).toMatchObject({ action: "requeue" });
  });

  it("試行の上限に達したら戻さず止める", () => {
    const failed = run({ conclusion: "failure", attempt: 2 });
    const state = { ...release, releaseAttempts: DEPLOY_RECOVERY_MAX_RELEASE_ATTEMPTS - 1, lastFailureKey: "failure:a" };
    expect(decideDeployRecoveryRelease(state, { now, runs: [failed], versionVerified: false, failureKey: "failure:b" })).toMatchObject({
      action: "stop",
      reason: "release_attempts_exhausted",
    });
  });
});

describe("releasingは進行中（#4451）", () => {
  it("releasing・verifyingは進行中で、停止や自動更新の対象になる", () => {
    expect(isDeployRecoveryActive("releasing")).toBe(true);
    expect(isDeployRecoveryActive("verifying")).toBe(true);
    expect(isDeployRecoveryActive("awaiting_release")).toBe(false);
    expect(isDeployRecoveryActive("recovered")).toBe(false);
  });

  it("6段階の現在位置へ写す。止まっている状態は位置を持たない", () => {
    expect(deployRecoveryStage("investigating")).toMatchObject({ index: 0, label: "原因を調査中" });
    expect(deployRecoveryStage("fixing").index).toBe(1);
    expect(deployRecoveryStage("awaiting_main_merge").index).toBe(2);
    expect(deployRecoveryStage("releasing")).toMatchObject({ index: 3, label: "本番へ反映中" });
    expect(deployRecoveryStage("verifying")).toMatchObject({ index: 4, label: "稼働確認中" });
    expect(deployRecoveryStage("recovered")).toMatchObject({ index: 5, label: "完了" });
    expect(deployRecoveryStage("needs_attention").index).toBe(-1);
  });
});

describe("修正済み（already_fixed）の分岐（#4451）", () => {
  const reported = { reportedCause: "already_fixed" as const };
  it("修正済みのPRが確かめられるまで待つ", () => {
    expect(decideDeployRecovery(series(), observed(reported))).toEqual({ action: "wait" });
  });

  it("マージ済みなら修正の工程を飛ばして復旧PRの工程へ進む（新しいPRは作らない）", () => {
    const merged = { number: 4447, state: "closed" as const, merged: true };
    expect(decideDeployRecovery(series({ scope: "fix_until_main" }), observed({ ...reported, pullRequest: merged }))).toEqual({
      action: "transition",
      status: "awaiting_main_merge",
      cause: "already_fixed",
      pullRequestNumber: 4447,
    });
    expect(decideDeployRecovery(series(), observed({ ...reported, pullRequest: merged }))).toMatchObject({ status: "awaiting_release" });
  });

  it("報告されたPRがマージされていなければ修正済みと扱わない", () => {
    expect(decideDeployRecovery(series(), observed({ ...reported, pullRequest: openPr }))).toMatchObject({
      action: "stop",
      reason: "fix_not_merged",
    });
  });

  it("修正済みのPR番号を最後の報告から読む", () => {
    expect(
      parseDeployRecoveryFixPullRequest(["<!-- issue-deck-deploy-recovery-fix-pr:4446 -->", "<!-- issue-deck-deploy-recovery-fix-pr:4447 -->"]),
    ).toBe(4447);
    expect(parseDeployRecoveryFixPullRequest(["なし", null])).toBeNull();
  });
});
