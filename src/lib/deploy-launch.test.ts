import { describe, expect, it } from "vitest";

import {
  buildDeployLaunchDispatchComment,
  buildDeployLaunchFailedComment,
  decideDeployLaunch,
  deployLaunchGiveUpMinutes,
  deployLaunchGraceSeconds,
  DEPLOY_LAUNCH_MAX_ATTEMPTS,
  isRunCoveringMerge,
  type DeployLaunchWatchInput,
} from "@/lib/deploy-launch";
import type { DeployWorkflowRunRef } from "@/lib/github/release-api";

const MERGED_AT = new Date("2026-09-01T12:39:48Z");
const MERGE_SHA = "db53cd2aa11223344556677889900aabbccddeef";

function watch(overrides: Partial<DeployLaunchWatchInput> = {}): DeployLaunchWatchInput {
  return {
    repositoryFullName: "guchi-apps/myroom",
    pullRequestNumber: 312,
    pullRequestTitle: "v4.8.0をリリースする。",
    mergeCommitSha: MERGE_SHA,
    mergedAt: MERGED_AT,
    attempts: 0,
    ...overrides,
  };
}

function run(overrides: Partial<DeployWorkflowRunRef> = {}): DeployWorkflowRunRef {
  return {
    id: 901,
    htmlUrl: "https://github.com/guchi-apps/myroom/actions/runs/901",
    createdAt: "2026-09-01T12:39:52Z",
    event: "push",
    headSha: MERGE_SHA,
    headBranch: "main",
    headTreeSha: "tree-of-merge-commit",
    ...overrides,
  };
}

/** 猶予（90秒）を過ぎた時刻 */
const AFTER_GRACE = new Date(MERGED_AT.getTime() + 120_000);
/** 猶予の中の時刻 */
const WITHIN_GRACE = new Date(MERGED_AT.getTime() + 30_000);

describe("deployLaunchGraceSeconds", () => {
  it("未設定なら90秒", () => {
    expect(deployLaunchGraceSeconds(undefined)).toBe(90);
    expect(deployLaunchGraceSeconds("")).toBe(90);
  });

  it("数値でない・負の値は既定値へ倒す", () => {
    expect(deployLaunchGraceSeconds("abc")).toBe(90);
    expect(deployLaunchGraceSeconds("-1")).toBe(90);
  });

  it("0は「見張りごと無効」としてそのまま返す", () => {
    expect(deployLaunchGraceSeconds("0")).toBe(0);
  });

  it("設定した値を使う", () => {
    expect(deployLaunchGraceSeconds("60")).toBe(60);
  });
});

describe("deployLaunchGiveUpMinutes", () => {
  it("未設定なら30分", () => {
    expect(deployLaunchGiveUpMinutes(undefined)).toBe(30);
  });

  it("0は「諦めない」としてそのまま返す", () => {
    expect(deployLaunchGiveUpMinutes("0")).toBe(0);
  });
});

describe("isRunCoveringMerge", () => {
  it("head_shaがマージコミットと一致すれば出している", () => {
    expect(isRunCoveringMerge(run(), { mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT })).toBe(true);
  });

  it("treeが一致すれば、別のrefから起動された実行でも出している", () => {
    const manual = run({
      headSha: "0000000000000000000000000000000000000000",
      headBranch: "release-main/v4.8.0",
      createdAt: "2026-09-01T12:20:00Z",
      event: "workflow_dispatch",
    });
    expect(
      isRunCoveringMerge(manual, { mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT }, "tree-of-merge-commit"),
    ).toBe(true);
    // treeを渡さなければ照合しない（猶予の中では引かないため）
    expect(isRunCoveringMerge(manual, { mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT })).toBe(false);
  });

  it("mainブランチでマージより後に作られた実行は、後続のマージぶんでも出している", () => {
    const later = run({
      headSha: "1111111111111111111111111111111111111111",
      headTreeSha: "another-tree",
      createdAt: "2026-09-01T12:41:00Z",
    });
    expect(isRunCoveringMerge(later, { mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT })).toBe(true);
  });

  it("マージより前のmainの実行は出していない", () => {
    const older = run({
      headSha: "2222222222222222222222222222222222222222",
      headTreeSha: "old-tree",
      createdAt: "2026-09-01T10:00:00Z",
    });
    expect(isRunCoveringMerge(older, { mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT })).toBe(false);
  });

  it("main以外のブランチの新しい実行は、SHAもtreeも違えば出していない", () => {
    const other = run({
      headSha: "3333333333333333333333333333333333333333",
      headBranch: "develop",
      headTreeSha: "develop-tree",
      createdAt: "2026-09-01T12:45:00Z",
    });
    expect(isRunCoveringMerge(other, { mergeCommitSha: MERGE_SHA, mergedAt: MERGED_AT })).toBe(false);
  });

  it("head_shaが空文字の実行を「一致」と読まない", () => {
    const broken = run({ headSha: "", headBranch: null, headTreeSha: null, createdAt: "" });
    expect(isRunCoveringMerge(broken, { mergeCommitSha: "", mergedAt: MERGED_AT })).toBe(false);
  });
});

describe("decideDeployLaunch", () => {
  it("マージコミットの実行が作られていれば畳む", () => {
    const decision = decideDeployLaunch({ watch: watch(), runs: [run()], now: AFTER_GRACE });
    expect(decision).toEqual({
      kind: "covered",
      runUrl: "https://github.com/guchi-apps/myroom/actions/runs/901",
    });
  });

  it("実行が無くても猶予の中なら待つ", () => {
    const decision = decideDeployLaunch({ watch: watch(), runs: [], now: WITHIN_GRACE });
    expect(decision).toEqual({ kind: "wait" });
  });

  it("猶予を過ぎて実行が1件も無ければ起動し直す（myroom#315の状況）", () => {
    const decision = decideDeployLaunch({ watch: watch(), runs: [], now: AFTER_GRACE });
    expect(decision).toEqual({ kind: "dispatch" });
  });

  it("猶予を過ぎても、直近の実行がマージより前のものだけなら起動し直す", () => {
    const older = run({
      headSha: "2222222222222222222222222222222222222222",
      headTreeSha: "old-tree",
      createdAt: "2026-09-01T10:00:00Z",
    });
    expect(decideDeployLaunch({ watch: watch(), runs: [older], now: AFTER_GRACE })).toEqual({
      kind: "dispatch",
    });
  });

  it("treeで一致すれば、猶予を過ぎていても起動し直さない", () => {
    const manual = run({
      headSha: "0000000000000000000000000000000000000000",
      headBranch: "release-main/v4.8.0",
      createdAt: "2026-09-01T12:20:00Z",
    });
    const decision = decideDeployLaunch({
      watch: watch(),
      runs: [manual],
      now: AFTER_GRACE,
      mergeTreeSha: "tree-of-merge-commit",
    });
    expect(decision.kind).toBe("covered");
  });

  it("試行回数を使い切ったら諦める", () => {
    const decision = decideDeployLaunch({
      watch: watch({ attempts: DEPLOY_LAUNCH_MAX_ATTEMPTS }),
      runs: [],
      now: AFTER_GRACE,
    });
    expect(decision).toEqual({ kind: "give_up", reason: "attempts" });
  });

  it("諦めるまでの時間を過ぎたら諦める", () => {
    const decision = decideDeployLaunch({
      watch: watch(),
      runs: [],
      now: new Date(MERGED_AT.getTime() + 31 * 60_000),
    });
    expect(decision).toEqual({ kind: "give_up", reason: "timeout" });
  });

  it("諦めるまでの時間を0にすると諦めない", () => {
    const decision = decideDeployLaunch({
      watch: watch(),
      runs: [],
      now: new Date(MERGED_AT.getTime() + 24 * 60 * 60_000),
      giveUpMinutes: 0,
    });
    expect(decision).toEqual({ kind: "dispatch" });
  });

  it("諦めるより先に、実行が見つかれば畳む", () => {
    const decision = decideDeployLaunch({
      watch: watch({ attempts: DEPLOY_LAUNCH_MAX_ATTEMPTS }),
      runs: [run()],
      now: new Date(MERGED_AT.getTime() + 60 * 60_000),
    });
    expect(decision.kind).toBe("covered");
  });
});

describe("buildDeployLaunchDispatchComment", () => {
  it("何が起きて何をしたのかと、確認先を書く", () => {
    const body = buildDeployLaunchDispatchComment({ mergeCommitSha: MERGE_SHA, graceSeconds: 90 });
    expect(body).toContain("db53cd2");
    expect(body).toContain("90秒");
    expect(body).toContain("deploy-retry.yml");
    expect(body).toContain("<!-- issue-deck:deploy-launch-dispatched -->");
  });
});

describe("buildDeployLaunchFailedComment", () => {
  it("手で起動するコマンドを--ref mainで示し、他のrefを使わない理由まで書く", () => {
    const body = buildDeployLaunchFailedComment({
      mergeCommitSha: MERGE_SHA,
      repositoryFullName: "guchi-apps/myroom",
      reason: "403 Forbidden",
    });
    expect(body).toContain("gh workflow run deploy.yml --repo guchi-apps/myroom --ref main");
    expect(body).toContain("403 Forbidden");
    expect(body).toContain("tag");
    expect(body).toContain("<!-- issue-deck:deploy-launch-failed -->");
  });
});
