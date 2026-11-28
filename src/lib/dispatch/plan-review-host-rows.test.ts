import { describe, expect, it } from "vitest";

import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import {
  describePlanReviewWaitReason,
  selectHostPlanReviewRows,
  selectPlanReviewsWithoutHost,
} from "@/lib/dispatch/plan-review-host-rows";
import type { DispatchPlanReviewSession } from "@/lib/dispatch/plan-review-session";

const NOW = new Date("2026-11-27T23:25:30.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function makeJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 5654,
    issueTitle: "AI使用料画面",
    issueId: "issue-5654",
    targetHost: "subpc",
    agent: "claude",
    claudeModel: "opus",
    kind: "PLAN_REVIEW",
    status: "QUEUED",
    message: null,
    instruction: null,
    recovery: false,
    command: null,
    placeholderValues: null,
    resolvedCommand: null,
    manualStepLine: null,
    manualStepRunTarget: "subpc",
    targetJobId: null,
    previewAction: null,
    exitCode: null,
    commandOutput: null,
    codexPairingCode: null,
    codexPairingExpiresAt: null,
    tmuxSessionName: null,
    queuePriority: 0,
    createdAt: ago(60_000),
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function session(issueNumber: number): DispatchPlanReviewSession {
  return {
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber,
    issueTitle: `写し${issueNumber}`,
    issueId: null,
  };
}

const host = (planReviewSessions: DispatchPlanReviewSession[] = []) => ({
  name: "subpc",
  planReviewSessions,
});

describe("selectHostPlanReviewRows", () => {
  it("起動待ちを、積んだ時刻とともに出す", () => {
    const rows = selectHostPlanReviewRows({ host: host(), jobs: [makeJob()], now: NOW });
    expect(rows).toMatchObject([{ state: "queued", issueNumber: 5654, since: ago(60_000) }]);
  });

  it("10分を超えた起動待ち（queued_overdue）も外さない", () => {
    const rows = selectHostPlanReviewRows({
      host: host(),
      jobs: [makeJob({ createdAt: ago(3 * 60 * 60_000) })],
      now: NOW,
    });
    expect(rows.map((row) => row.state)).toEqual(["queued"]);
  });

  it("起動直後で写しに無くても、指摘が届くまではレビュー中として出す", () => {
    const rows = selectHostPlanReviewRows({
      host: host(),
      jobs: [makeJob({ status: "SUCCEEDED", claimedAt: ago(20_000), finishedAt: ago(20_000) })],
      now: NOW,
    });
    expect(rows).toMatchObject([{ state: "reviewing", since: ago(20_000) }]);
  });

  it("指摘が届いたら外す", () => {
    const rows = selectHostPlanReviewRows({
      host: host(),
      jobs: [makeJob({ status: "SUCCEEDED", finishedAt: ago(60_000), reviewPostedAt: ago(5_000) })],
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it("指摘が届かないまま猶予（10分）を過ぎたら外す", () => {
    const rows = selectHostPlanReviewRows({
      host: host(),
      jobs: [makeJob({ status: "SUCCEEDED", finishedAt: ago(11 * 60_000) })],
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it("写しにだけあるものもレビュー中として出す", () => {
    const rows = selectHostPlanReviewRows({ host: host([session(3924)]), jobs: [], now: NOW });
    expect(rows).toMatchObject([
      { state: "reviewing", issueNumber: 3924, issueTitle: "写し3924", job: null },
    ]);
  });

  it("写しとジョブが同じIssueなら1行にまとめる", () => {
    const rows = selectHostPlanReviewRows({
      host: host([session(5654)]),
      jobs: [makeJob({ status: "RUNNING", startedAt: ago(10_000) })],
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "reviewing", issueTitle: "AI使用料画面" });
  });

  it("同じIssueは新しいジョブだけを見る（前回の終わったレビューで行を出さない）", () => {
    const rows = selectHostPlanReviewRows({
      host: host(),
      jobs: [
        makeJob({ id: "old", status: "SUCCEEDED", createdAt: ago(5 * 60_000), finishedAt: ago(4 * 60_000) }),
        makeJob({ id: "new", status: "QUEUED", createdAt: ago(30_000) }),
      ],
      now: NOW,
    });
    expect(rows).toMatchObject([{ state: "queued", job: { id: "new" } }]);
  });

  it("他のホスト宛て・計画レビュー以外のジョブは拾わない", () => {
    const rows = selectHostPlanReviewRows({
      host: host(),
      jobs: [makeJob({ targetHost: "macmini" }), makeJob({ kind: "LAUNCH" })],
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it("レビュー中を起動待ちより上に並べる", () => {
    const rows = selectHostPlanReviewRows({
      host: host(),
      jobs: [
        makeJob({ id: "q", issueNumber: 1, createdAt: ago(2 * 60_000) }),
        makeJob({ id: "r", issueNumber: 2, status: "RUNNING", startedAt: ago(10_000) }),
      ],
      now: NOW,
    });
    expect(rows.map((row) => row.state)).toEqual(["reviewing", "queued"]);
  });
});

describe("describePlanReviewWaitReason", () => {
  it("起動を見送っている理由を返す", () => {
    expect(
      describePlanReviewWaitReason({
        online: true,
        launchHold: { reason: "CPU", percent: 99, thresholdPercent: 90 },
      }),
    ).toBe("CPU 99%（上限 90%）のため");
  });

  it("分からなければnull", () => {
    expect(describePlanReviewWaitReason({ online: true, launchHold: null })).toBeNull();
  });
});

describe("selectPlanReviewsWithoutHost", () => {
  it("宛先ホストが一覧に無いものだけを返す", () => {
    const jobs = [makeJob({ id: "a" }), makeJob({ id: "b", targetHost: "gone" })];
    expect(selectPlanReviewsWithoutHost(jobs, [{ name: "subpc" }]).map((job) => job.id)).toEqual(["b"]);
  });
});
