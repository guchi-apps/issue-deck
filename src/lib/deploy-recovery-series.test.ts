import { describe, expect, it } from "vitest";

import {
  decideDeployRecovery,
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
