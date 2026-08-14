import { describe, expect, it } from "vitest";

import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import {
  cancelableDispatchJobs,
  describeDispatchJobWaitReason,
  describeDispatchQueueLoad,
  describeDispatchQueueStall,
  summarizeDispatchQueue,
  summarizeDispatchSessionCapacity,
} from "@/lib/dispatch/queue-summary";

function job(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    targetHost: "subpc",
    kind: "LAUNCH",
    status: "QUEUED",
    message: null,
    tmuxSessionName: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 1,
    online: true,
    lastSeenAt: "2026-08-14T00:00:00.000Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    maxSessions: 12,
    liveSessions: 3,
    ...overrides,
  };
}

describe("summarizeDispatchQueue", () => {
  it("待機は積んだ順（＝払い出される順）に並べる", () => {
    const summary = summarizeDispatchQueue(
      [
        job({ id: "c", createdAt: "2026-08-14T03:00:00.000Z" }),
        job({ id: "a", createdAt: "2026-08-14T01:00:00.000Z" }),
        job({ id: "b", createdAt: "2026-08-14T02:00:00.000Z" }),
      ],
      2,
    );
    expect(summary.queued.map((j) => j.id)).toEqual(["a", "b", "c"]);
  });

  it("CLAIMEDとRUNNINGは実行中として数える", () => {
    const summary = summarizeDispatchQueue(
      [job({ id: "a", status: "CLAIMED" }), job({ id: "b", status: "RUNNING" })],
      2,
    );
    expect(summary.running.map((j) => j.id)).toEqual(["a", "b"]);
    expect(summary.activeCount).toBe(2);
  });

  it("失敗とタイムアウトは新しい順に出す", () => {
    const summary = summarizeDispatchQueue(
      [
        job({ id: "old", status: "FAILED", createdAt: "2026-08-14T01:00:00.000Z" }),
        job({ id: "new", status: "TIMEOUT", createdAt: "2026-08-14T02:00:00.000Z" }),
      ],
      2,
    );
    expect(summary.failed.map((j) => j.id)).toEqual(["new", "old"]);
  });

  it("成功したジョブはキューに含めない（バッジが減らなくなる）", () => {
    const summary = summarizeDispatchQueue([job({ status: "SUCCEEDED" })], 2);
    expect(summary.activeCount).toBe(0);
    expect(summary.failed).toHaveLength(0);
  });

  // 起動ジョブ以外は同時実行数の枠を使わない（#1332の制御ジョブと同じ理由。#1294）
  it("制御ジョブと質問ジョブは数えない", () => {
    const summary = summarizeDispatchQueue(
      [job({ id: "control", kind: "INTERRUPT" }), job({ id: "question", kind: "QUESTION" })],
      2,
    );
    expect(summary.activeCount).toBe(0);
    expect(summary.queued).toHaveLength(0);
  });
});

describe("describeDispatchQueueLoad", () => {
  it("上限が分かれば分母を出す", () => {
    const summary = summarizeDispatchQueue(
      [job({ status: "RUNNING" }), job({ id: "q" })],
      2,
    );
    expect(describeDispatchQueueLoad(summary)).toBe("実行中 1/2・待機 1");
  });

  it("待機が無ければ実行中だけ出す", () => {
    expect(describeDispatchQueueLoad(summarizeDispatchQueue([], 2))).toBe("実行中 0/2");
  });

  it("上限が分からなければ分母を出さない", () => {
    expect(describeDispatchQueueLoad(summarizeDispatchQueue([], null))).toBe("実行中 0");
  });
});

describe("summarizeDispatchSessionCapacity", () => {
  it("上限に達していれば印を付ける", () => {
    expect(summarizeDispatchSessionCapacity([host({ liveSessions: 12 })])).toEqual([
      { hostName: "subpc", live: 12, max: 12, atCapacity: true },
    ]);
  });

  // 判定材料が無いまま0本として並べると、実際には埋まっているホストが空いて見える
  it("本数を申告していないホスト（古いpoller）は落とす", () => {
    expect(summarizeDispatchSessionCapacity([host({ maxSessions: null })])).toEqual([]);
    expect(summarizeDispatchSessionCapacity([host({ liveSessions: null })])).toEqual([]);
  });

  it("0本は「申告していない」とは別物として扱う", () => {
    expect(summarizeDispatchSessionCapacity([host({ liveSessions: 0 })])).toEqual([
      { hostName: "subpc", live: 0, max: 12, atCapacity: false },
    ]);
  });
});

describe("describeDispatchQueueStall", () => {
  const queued = summarizeDispatchQueue([job()], 2);

  it("上限に達しているホストがあれば理由を出す", () => {
    expect(describeDispatchQueueStall(queued, [host({ liveSessions: 12 })])).toContain(
      "subpc（12/12本）",
    );
  });

  it("待機が無ければ理由を出さない", () => {
    const empty = summarizeDispatchQueue([], 2);
    expect(describeDispatchQueueStall(empty, [host({ liveSessions: 12 })])).toBeNull();
  });

  // 落ちているホストは「上限で待っている」のではなく「取りに来られない」
  it("応答していないホストは数えない", () => {
    expect(
      describeDispatchQueueStall(queued, [host({ liveSessions: 12, online: false })]),
    ).toBeNull();
  });

  it("空きがあれば理由を出さない", () => {
    expect(describeDispatchQueueStall(queued, [host()])).toBeNull();
  });
});

describe("describeDispatchJobWaitReason", () => {
  it("順番待ちのジョブに、上限で止まっている理由を添える", () => {
    const reason = describeDispatchJobWaitReason(job(), [host({ liveSessions: 12 })]);
    expect(reason).toContain("上限（12/12本）");
  });

  it("走り出したジョブには添えない", () => {
    expect(
      describeDispatchJobWaitReason(job({ status: "RUNNING" }), [host({ liveSessions: 12 })]),
    ).toBeNull();
  });

  // 制御ジョブ（#1332）はセッション本数の上限に達していても払い出される
  it("制御ジョブには添えない", () => {
    expect(
      describeDispatchJobWaitReason(job({ kind: "KILL" }), [host({ liveSessions: 12 })]),
    ).toBeNull();
  });

  it("宛先のホストが申告に無ければ添えない", () => {
    expect(
      describeDispatchJobWaitReason(job({ targetHost: "other" }), [host({ liveSessions: 12 })]),
    ).toBeNull();
  });
});

describe("cancelableDispatchJobs", () => {
  // runningを止めるとworktreeの作成や依存インストールの途中で切れ、中途半端な状態が残る
  it("待機とCLAIMEDまで。RUNNINGは含めない", () => {
    const summary = summarizeDispatchQueue(
      [
        job({ id: "q" }),
        job({ id: "c", status: "CLAIMED" }),
        job({ id: "r", status: "RUNNING" }),
      ],
      2,
    );
    expect(cancelableDispatchJobs(summary).map((j) => j.id).sort()).toEqual(["c", "q"]);
  });
});
