import { describe, expect, it } from "vitest";

import {
  decideManualRecoveryRelease,
  decideRecoveryMainMerge,
  parseDeployRecoveryScope,
  type RecoveryMergeObservation,
  type RecoveryMergeSeries,
} from "./deploy-recovery-main-merge";

const now = new Date("2026-10-05T12:00:00Z");
const series = (overrides: Partial<RecoveryMergeSeries> = {}): RecoveryMergeSeries => ({
  status: "awaiting_main_merge",
  scope: "fix_until_main",
  expiresAt: new Date(now.getTime() + 3600_000),
  stoppedAt: null,
  startedByUserId: "user-1",
  fixMergeCommitSha: "fix",
  recoveryPullRequestNumber: 9,
  recoveryHeadRef: "deploy-recovery/1-1-x",
  recoveryHeadSha: "head1",
  recoveryBaseSha: "main1",
  recoveryFiles: ["src/a.ts", "package.json"],
  ...overrides,
});
const observed = (overrides: Partial<RecoveryMergeObservation> = {}): RecoveryMergeObservation => ({
  now,
  pullRequest: {
    number: 9,
    state: "open",
    merged: false,
    baseRef: "main",
    headRef: "deploy-recovery/1-1-x",
    headSha: "head1",
    mergeable: true,
    labels: [],
  },
  mainSha: "main1",
  fixAlreadyInMain: false,
  ciState: "success",
  files: { names: ["src/a.ts", "package.json"], truncated: false },
  ...overrides,
});
const pull = (patch: Partial<NonNullable<RecoveryMergeObservation["pullRequest"]>>) => ({
  ...observed().pullRequest!,
  ...patch,
});

describe("decideRecoveryMainMerge", () => {
  it("記録どおりでCIが現在のHEADで通っていればマージする", () => {
    expect(decideRecoveryMainMerge(series(), observed())).toEqual({ action: "merge" });
  });

  it("developまでしか許可していない系列・停止・期限切れではマージしない", () => {
    expect(decideRecoveryMainMerge(series({ scope: "fix_until_develop" }), observed())).toMatchObject({ reason: "scope_not_allowed" });
    expect(decideRecoveryMainMerge(series({ stoppedAt: now }), observed())).toMatchObject({ reason: "stopped_by_user" });
    expect(decideRecoveryMainMerge(series({ expiresAt: now }), observed())).toMatchObject({ reason: "timed_out" });
    expect(decideRecoveryMainMerge(series({ startedByUserId: "" }), observed())).toMatchObject({ reason: "scope_not_allowed" });
  });

  it("記録と違うPR・HEAD・baseでは、ラベルやマーカーがあっても止める", () => {
    expect(decideRecoveryMainMerge(series(), observed({ pullRequest: pull({ number: 10 }) }))).toMatchObject({ reason: "recovery_pull_request_mismatch" });
    expect(decideRecoveryMainMerge(series(), observed({ pullRequest: pull({ baseRef: "develop" }) }))).toMatchObject({ reason: "recovery_pull_request_mismatch" });
    expect(decideRecoveryMainMerge(series(), observed({ pullRequest: pull({ headSha: "head2" }) }))).toMatchObject({ reason: "head_changed" });
    expect(decideRecoveryMainMerge(series(), observed({ mainSha: "main2" }))).toMatchObject({ reason: "base_changed" });
  });

  it("別のリリースが修正を取り込んでいたら置換済みとして止める", () => {
    expect(decideRecoveryMainMerge(series(), observed({ fixAlreadyInMain: true }))).toMatchObject({ reason: "superseded_by_release" });
  });

  it("差分が記録した範囲を超える・数えきれないときは止める", () => {
    expect(decideRecoveryMainMerge(series(), observed({ files: { names: ["src/a.ts", "src/other.ts"], truncated: false } }))).toMatchObject({
      reason: "diff_out_of_scope",
      detail: "src/other.ts",
    });
    expect(decideRecoveryMainMerge(series(), observed({ files: { names: [], truncated: true } }))).toMatchObject({ reason: "diff_out_of_scope" });
  });

  it("CIが未完了・不明なら待ち、失敗なら止める。人の確認ラベルがあれば止める", () => {
    expect(decideRecoveryMainMerge(series(), observed({ ciState: "pending" }))).toMatchObject({ action: "wait" });
    expect(decideRecoveryMainMerge(series(), observed({ ciState: "unknown" }))).toMatchObject({ action: "wait" });
    expect(decideRecoveryMainMerge(series(), observed({ ciState: "failure" }))).toMatchObject({ reason: "ci_failed" });
    expect(decideRecoveryMainMerge(series(), observed({ pullRequest: pull({ labels: ["22.merge-confirm-required"] }) }))).toMatchObject({
      reason: "blocked_by_label",
    });
  });

  it("復旧PRが未作成・コンフリクト判定中なら待つ", () => {
    expect(decideRecoveryMainMerge(series({ recoveryPullRequestNumber: null }), observed())).toMatchObject({ action: "wait" });
    expect(decideRecoveryMainMerge(series(), observed({ pullRequest: pull({ mergeable: null }) }))).toMatchObject({ action: "wait" });
    expect(decideRecoveryMainMerge(series(), observed({ pullRequest: pull({ mergeable: false }) }))).toMatchObject({ reason: "base_changed" });
  });

  it("範囲の文字列は定義済みのものだけを受け付ける", () => {
    expect(parseDeployRecoveryScope("fix_until_main")).toBe("fix_until_main");
    expect(parseDeployRecoveryScope("all")).toBeNull();
  });
});

describe("decideManualRecoveryRelease（#4451）", () => {
  const linked = {
    status: "awaiting_release",
    expiresAt: new Date(now.getTime() + 3600_000),
    stoppedAt: null,
    recoveryPullRequestNumber: 9,
    recoveryHeadSha: "head1",
    recoveryFiles: ["src/a.ts", "package.json"],
  };
  const merged = {
    number: 9,
    state: "closed" as const,
    merged: true,
    baseRef: "main",
    headSha: "head1",
    mergeCommitSha: "merge1",
  };
  const obs = (over: Partial<Parameters<typeof decideManualRecoveryRelease>[1]> = {}) => ({
    now,
    pullRequest: merged,
    files: { names: ["src/a.ts"], truncated: false },
    ...over,
  });

  it("記録した復旧PRが記録どおりにマージされたときだけ、そのマージSHAで反映の追跡へ進む", () => {
    expect(decideManualRecoveryRelease(linked, obs())).toEqual({ action: "release", mergeSha: "merge1" });
  });

  it("未マージの間は待ち、閉じられたら紐付けを外す", () => {
    expect(decideManualRecoveryRelease(linked, obs({ pullRequest: { ...merged, merged: false, state: "open" } }))).toMatchObject({ action: "wait" });
    expect(decideManualRecoveryRelease(linked, obs({ pullRequest: { ...merged, merged: false } }))).toMatchObject({
      action: "unlink",
      reason: "recovery_pull_request_closed",
    });
  });

  it("別のPR・main以外・HEADの変化・範囲外の差分は承認範囲外としてつながない", () => {
    expect(decideManualRecoveryRelease(linked, obs({ pullRequest: { ...merged, number: 10 } }))).toMatchObject({ action: "unlink" });
    expect(decideManualRecoveryRelease(linked, obs({ pullRequest: { ...merged, baseRef: "develop" } }))).toMatchObject({ action: "unlink" });
    expect(decideManualRecoveryRelease(linked, obs({ pullRequest: { ...merged, headSha: "other" } }))).toMatchObject({
      action: "unlink",
      reason: "head_changed",
    });
    expect(decideManualRecoveryRelease(linked, obs({ files: { names: ["src/evil.ts"], truncated: false } }))).toMatchObject({
      action: "unlink",
      reason: "diff_out_of_scope",
    });
  });

  it("観測できないものは待ち、停止・期限切れは紐付けを外す", () => {
    expect(decideManualRecoveryRelease(linked, obs({ pullRequest: null }))).toMatchObject({ action: "wait" });
    expect(decideManualRecoveryRelease(linked, obs({ files: null }))).toMatchObject({ action: "wait" });
    expect(decideManualRecoveryRelease(linked, obs({ pullRequest: { ...merged, mergeCommitSha: null } }))).toMatchObject({ action: "wait" });
    expect(decideManualRecoveryRelease({ ...linked, stoppedAt: now }, obs())).toMatchObject({ action: "unlink", reason: "stopped_by_user" });
    expect(decideManualRecoveryRelease({ ...linked, expiresAt: now }, obs())).toMatchObject({ action: "unlink", reason: "timed_out" });
  });
});
