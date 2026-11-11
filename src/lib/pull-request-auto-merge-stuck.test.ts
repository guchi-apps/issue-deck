import { describe, expect, it } from "vitest";

import { MERGE_JUDGEMENT_UNKNOWN, type MergeJudgement } from "@/lib/github/check-rollup";
import {
  AUTO_MERGE_STUCK_AFTER_MS,
  decideAutoMergeStuckRescue,
  type AutoMergeStuckInput,
} from "@/lib/pull-request-auto-merge-stuck";

const NOW = new Date("2026-11-10T08:00:00.000Z");
const JUDGED_AT = new Date(NOW.getTime() - AUTO_MERGE_STUCK_AFTER_MS - 1000).toISOString();

const settled: MergeJudgement = {
  ...MERGE_JUDGEMENT_UNKNOWN,
  state: "settled",
  autoMergeRun: { url: null, completedAt: JUDGED_AT },
};

function input(overrides: Partial<AutoMergeStuckInput> = {}): AutoMergeStuckInput {
  return {
    now: NOW,
    pullRequest: { draft: false, baseRef: "develop", headSha: "abc", autoMergeEnabled: true },
    rollupState: "success",
    mergeJudgement: settled,
    alreadyAttempted: false,
    ...overrides,
  };
}

/**
 * #5326。予約（`gh pr merge --auto`）したまま、必須チェックが通ってもGitHubがマージを起こさず
 * 止まったPR（#5287は8時間）を、`auto-merge`ジョブの再実行で拾い直す。
 */
describe("decideAutoMergeStuckRescue", () => {
  it("予約済み・判定済み・チェック成功のまま一定時間開いているPRはやり直す", () => {
    expect(decideAutoMergeStuckRescue(input())).toEqual({ action: "rerun" });
  });

  it("予約していないPRは対象外（止めた理由があるか、判定がまだ）", () => {
    expect(
      decideAutoMergeStuckRescue(
        input({ pullRequest: { draft: false, baseRef: "develop", headSha: "abc", autoMergeEnabled: false } }),
      ),
    ).toEqual({ action: "skip", reason: "not_scheduled" });
  });

  it("下書き・develop以外へのPRは対象外", () => {
    expect(
      decideAutoMergeStuckRescue(
        input({ pullRequest: { draft: true, baseRef: "develop", headSha: "abc", autoMergeEnabled: true } }),
      ).action,
    ).toBe("skip");
    expect(
      decideAutoMergeStuckRescue(
        input({ pullRequest: { draft: false, baseRef: "main", headSha: "abc", autoMergeEnabled: true } }),
      ).action,
    ).toBe("skip");
  });

  it("判定の途中（再実行中を含む）は、その判定に任せる", () => {
    expect(decideAutoMergeStuckRescue(input({ mergeJudgement: { ...settled, state: "pending" } }))).toEqual({
      action: "skip",
      reason: "judging",
    });
  });

  it("チェックが通っていないものは、GitHubの予約が待っているのが正しい", () => {
    for (const rollupState of ["pending", "failure", null]) {
      expect(decideAutoMergeStuckRescue(input({ rollupState })).action).toBe("skip");
    }
  });

  it("判定から間もないものは待つ（ワークフローの後押しとGitHubの予約に任せる）", () => {
    const recent = new Date(NOW.getTime() - 60_000).toISOString();
    expect(
      decideAutoMergeStuckRescue(input({ mergeJudgement: { ...settled, autoMergeRun: { url: null, completedAt: recent } } })),
    ).toEqual({ action: "skip", reason: "within_grace" });
  });

  it("判定の時刻が読めなければ、止まったとは言えない", () => {
    expect(decideAutoMergeStuckRescue(input({ mergeJudgement: { ...settled, autoMergeRun: undefined } }))).toEqual({
      action: "skip",
      reason: "no_judgement_time",
    });
  });

  it("同じHEADでは1回だけ（やり直しても止まるものを叩き続けない）", () => {
    expect(decideAutoMergeStuckRescue(input({ alreadyAttempted: true }))).toEqual({
      action: "skip",
      reason: "already_attempted",
    });
  });
});
