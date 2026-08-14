import { describe, expect, it } from "vitest";

import type { DispatchJobView } from "@/lib/dispatch/dispatch-job";
import {
  cancelableDispatchJobs,
  describeDispatchQueueLoad,
  summarizeDispatchQueue,
} from "@/lib/dispatch/queue-summary";

function job(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    targetHost: "subpc",
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
