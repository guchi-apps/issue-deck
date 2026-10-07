import { describe, expect, it } from "vitest";

import { resolvePhaseDetail } from "@/lib/github/workflow-status";
import type { IssuePullRequestProgress } from "@/lib/issue-pull-request-progress";

function pr(over: Partial<IssuePullRequestProgress>): IssuePullRequestProgress {
  return { pullRequestNumber: 1, label: "マージ待ち", tone: "waiting", stopKind: null, steps: [], ...over };
}

describe("resolvePhaseDetail（#4128）", () => {
  it("レビュー中の停止はフェーズ内の詳細状態として出す", () => {
    expect(resolvePhaseDetail("develop-pr", { pullRequestProgress: pr({ stopKind: "ci", tone: "attention", label: "CI失敗" }) })).toEqual({ text: "CI失敗", tone: "attention" });
    expect(resolvePhaseDetail("develop-pr", { pullRequestProgress: pr({ stopKind: "conflict", tone: "attention" }) })?.text).toBe("コンフリクト解消待ち");
    expect(resolvePhaseDetail("develop-pr", { pullRequestProgress: pr({ stopKind: "review", tone: "attention" }) })?.text).toBe("修正対応中");
  });
  it("PR無しはレビュー開始待ち、マージ待ちはdevelopへマージ待ち", () => {
    expect(resolvePhaseDetail("develop-pr")?.text).toBe("レビュー開始待ち");
    expect(resolvePhaseDetail("develop-pr", { pullRequestProgress: pr({}) })?.text).toBe("developへマージ待ち");
    expect(resolvePhaseDetail("develop-pr", { pullRequestProgress: pr({ label: "判定実施中", tone: "running" }) })?.text).toBe("レビュー中");
  });
  it("リリースPRはmainへマージ待ち／中、失敗は赤", () => {
    expect(resolvePhaseDetail("release", { pullRequestProgress: pr({}) })?.text).toBe("mainへマージ待ち");
    expect(resolvePhaseDetail("release", { pullRequestProgress: pr({ label: "CI失敗", tone: "attention", stopKind: "ci" }) })?.tone).toBe("attention");
  });
  it("計画承認待ち・Ready", () => {
    expect(resolvePhaseDetail("planning", { planApprovalPending: true })?.text).toBe("計画承認待ち");
    expect(resolvePhaseDetail("ready")).toBeNull();
  });
});
