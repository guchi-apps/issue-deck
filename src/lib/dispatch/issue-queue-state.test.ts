import { describe, expect, it } from "vitest";

import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import {
  buildIssueQueueStates,
  describeIssueQueueState,
  findIssueQueueState,
} from "@/lib/dispatch/issue-queue-state";
import { summarizeDispatchQueue } from "@/lib/dispatch/queue-summary";

function job(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    issueTitle: null,
    issueId: null,
    targetHost: "subpc",
    agent: "claude",
    kind: "LAUNCH",
    status: "QUEUED",
    message: null,
    instruction: null,
    command: null,
    placeholderValues: null,
    resolvedCommand: null,
    manualStepLine: null,
    targetJobId: null,
    previewAction: null,
    exitCode: null,
    commandOutput: null,
    codexPairingCode: null,
    codexPairingExpiresAt: null,
    tmuxSessionName: null,
    queuePriority: 0,
    createdAt: "2026-08-14T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/** 並べ替えは実行キューの要約に任せる（本番の`IssueList`と同じ経路で組む） */
function statesOf(jobs: DispatchJobView[]) {
  return buildIssueQueueStates(summarizeDispatchQueue(jobs, null));
}

function stateFor(jobs: DispatchJobView[], issueNumber: number) {
  return findIssueQueueState(statesOf(jobs), "guchi-apps/issue-deck", issueNumber);
}

describe("buildIssueQueueStates", () => {
  it("順番待ちの番号は払い出しと同じ並び（優先度の降順→積んだ順）で振る", () => {
    const jobs = [
      job({ id: "a", issueNumber: 10, createdAt: "2026-08-14T00:00:00.000Z" }),
      job({ id: "b", issueNumber: 11, createdAt: "2026-08-14T00:01:00.000Z" }),
      // 後から積まれたが「先頭へ上げる」（#1541）を押されたもの
      job({
        id: "c",
        issueNumber: 12,
        createdAt: "2026-08-14T00:02:00.000Z",
        queuePriority: 1,
      }),
    ];

    expect(stateFor(jobs, 12)?.position).toBe(1);
    expect(stateFor(jobs, 10)?.position).toBe(2);
    expect(stateFor(jobs, 11)?.position).toBe(3);
    expect(stateFor(jobs, 10)?.queuedTotal).toBe(3);
  });

  it("受け取り済み・起動中は`starting`にして番号を持たせない", () => {
    const jobs = [
      job({ id: "a", issueNumber: 10, status: "CLAIMED" }),
      job({ id: "b", issueNumber: 11, status: "RUNNING" }),
      job({ id: "c", issueNumber: 12, status: "QUEUED" }),
    ];

    expect(stateFor(jobs, 10)).toMatchObject({ phase: "starting", position: null });
    expect(stateFor(jobs, 11)).toMatchObject({ phase: "starting", position: null });
    // 番号の分母は順番待ちの件数だけ。走り出したものは数えない
    expect(stateFor(jobs, 12)).toMatchObject({ phase: "queued", position: 1, queuedTotal: 1 });
  });

  it("終わったジョブは状態を持たない（起動済み・失敗・取り消し）", () => {
    for (const status of ["SUCCEEDED", "FAILED", "SKIPPED", "TIMEOUT", "CANCELED"] as const) {
      expect(stateFor([job({ issueNumber: 10, status })], 10)).toBeNull();
    }
  });

  it("セッションの枠を使わない制御ジョブは数えない", () => {
    const jobs = [
      job({ id: "a", issueNumber: 10, kind: "INTERRUPT" }),
      job({ id: "b", issueNumber: 11, kind: "INSTRUCTION" }),
      job({ id: "c", issueNumber: 12, kind: "MANUAL_STEP" }),
      job({ id: "d", issueNumber: 13, kind: "LAUNCH" }),
    ];

    expect(stateFor(jobs, 10)).toBeNull();
    expect(stateFor(jobs, 11)).toBeNull();
    expect(stateFor(jobs, 12)).toBeNull();
    expect(stateFor(jobs, 13)?.queuedTotal).toBe(1);
  });

  it("横断質問・計画レビューも枠を使うので順番待ちに数える（#1544と同じ集合）", () => {
    const jobs = [
      job({ id: "a", issueNumber: 10, kind: "CROSS_REPO_QUESTION" }),
      job({ id: "b", issueNumber: 11, kind: "PLAN_REVIEW", createdAt: "2026-08-14T00:01:00.000Z" }),
    ];

    expect(stateFor(jobs, 10)?.position).toBe(1);
    expect(stateFor(jobs, 11)?.position).toBe(2);
  });

  // 払い出しは`targetHost`で絞ってから並べる（`claimDispatchJobs`）。全ホストを通しで
  // 数えると、別ホスト宛てのジョブまで番号に混ざる
  it("番号はホストごとに数える", () => {
    const jobs = [
      job({ id: "a", issueNumber: 10, targetHost: "subpc" }),
      job({ id: "b", issueNumber: 11, targetHost: "other", createdAt: "2026-08-14T00:01:00.000Z" }),
      job({ id: "c", issueNumber: 12, targetHost: "subpc", createdAt: "2026-08-14T00:02:00.000Z" }),
    ];

    expect(stateFor(jobs, 10)).toMatchObject({ position: 1, queuedTotal: 2 });
    expect(stateFor(jobs, 12)).toMatchObject({ position: 2, queuedTotal: 2 });
    // 別ホストのキューは自分の中で1番目
    expect(stateFor(jobs, 11)).toMatchObject({ position: 1, queuedTotal: 1 });
  });

  it("鍵はリポジトリと番号の組。番号だけが同じ別リポジトリのIssueには一致しない", () => {
    const states = statesOf([job({ repositoryFullName: "guchi-apps/dayspan", issueNumber: 10 })]);

    expect(findIssueQueueState(states, "guchi-apps/dayspan", 10)).not.toBeNull();
    expect(findIssueQueueState(states, "guchi-apps/issue-deck", 10)).toBeNull();
  });
});

describe("describeIssueQueueState", () => {
  it("2件以上待っているときだけ番号を出す", () => {
    const jobs = [job({ id: "a", issueNumber: 10 }), job({ id: "b", issueNumber: 11 })];

    expect(describeIssueQueueState(stateFor(jobs, 10)!)).toBe("順番待ち 1番目");
    expect(describeIssueQueueState(stateFor([job({ issueNumber: 10 })], 10)!)).toBe("順番待ち");
  });

  it("起動中は番号を出さない", () => {
    const state = stateFor([job({ issueNumber: 10, status: "RUNNING" })], 10)!;

    expect(describeIssueQueueState(state)).toBe("起動中");
  });
});
