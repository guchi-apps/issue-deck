import { describe, expect, it } from "vitest";

import {
  buildDeployFailureIssueBody,
  buildDeployFailureIssueTitle,
  decideDeployFailure,
  deployFailureGraceMinutes,
  deployFailureSweepIntervalMinutes,
  parseDeployFailureMeta,
  type DeployFailureMeta,
  type DeployFailureSweepRun,
} from "@/lib/deploy-failure";

const NOW = new Date("2026-08-24T05:00:00Z");

function run(overrides: Partial<DeployFailureSweepRun> = {}): DeployFailureSweepRun {
  return {
    id: 482,
    status: "completed",
    conclusion: "failure",
    htmlUrl: "https://github.com/guchi-apps/myroom/actions/runs/482",
    // 既定は猶予（10分）を十分に過ぎた失敗
    updatedAt: "2026-08-24T04:30:00Z",
    runAttempt: 2,
    ...overrides,
  };
}

function meta(overrides: Partial<DeployFailureMeta> = {}): DeployFailureMeta {
  return {
    repositoryFullName: "guchi-apps/myroom",
    runId: 482,
    runUrl: "https://github.com/guchi-apps/myroom/actions/runs/482",
    version: "1.4.2",
    previousVersion: "1.4.1",
    failedJobs: ["deploy"],
    attempt: 2,
    detectedAt: "2026-08-24T05:00:00Z",
    ...overrides,
  };
}

describe("decideDeployFailure", () => {
  it("失敗のまま猶予を過ぎていれば起票する", () => {
    expect(decideDeployFailure({ run: run(), tracked: null, now: NOW })).toEqual({ kind: "create" });
  });

  it("実行を取れないときは何もしない（追跡中のIssueがあっても閉じない）", () => {
    // 「成功した」ことを確かめられていないため。
    expect(
      decideDeployFailure({ run: null, tracked: { issueNumber: 312, runId: 482 }, now: NOW }),
    ).toEqual({ kind: "skip", reason: "no_run" });
  });

  it("実行中は何もしない（自動再実行の最中に立てない）", () => {
    expect(
      decideDeployFailure({
        run: run({ status: "in_progress", conclusion: null }),
        tracked: null,
        now: NOW,
      }),
    ).toEqual({ kind: "skip", reason: "not_completed" });
  });

  it("失敗したばかりのうちは起票しない（自動再実行を待つ）", () => {
    expect(
      decideDeployFailure({
        run: run({ updatedAt: "2026-08-24T04:55:00Z" }),
        tracked: null,
        now: NOW,
      }),
    ).toEqual({ kind: "skip", reason: "within_grace" });
  });

  it("同じrunを追いかけているIssueが既にあれば起票し直さない", () => {
    expect(
      decideDeployFailure({ run: run(), tracked: { issueNumber: 312, runId: 482 }, now: NOW }),
    ).toEqual({ kind: "skip", reason: "already_tracked" });
  });

  it("別のrunが落ちたら、Issueを立て直さず開いている1件へ書き足す", () => {
    expect(
      decideDeployFailure({
        run: run({ id: 500 }),
        tracked: { issueNumber: 312, runId: 482 },
        now: NOW,
      }),
    ).toEqual({ kind: "update", issueNumber: 312 });
  });

  it("成功したら追跡中のIssueを閉じる", () => {
    expect(
      decideDeployFailure({
        run: run({ conclusion: "success" }),
        tracked: { issueNumber: 312, runId: 482 },
        now: NOW,
      }),
    ).toEqual({ kind: "close", issueNumber: 312 });
  });

  it("キャンセルでは閉じない（人が止めたものを「直った」と扱わない）", () => {
    expect(
      decideDeployFailure({
        run: run({ conclusion: "cancelled" }),
        tracked: { issueNumber: 312, runId: 482 },
        now: NOW,
      }),
    ).toEqual({ kind: "skip", reason: "not_failed" });
  });

  it("タイムアウトも失敗として扱う", () => {
    expect(
      decideDeployFailure({ run: run({ conclusion: "timed_out" }), tracked: null, now: NOW }),
    ).toEqual({ kind: "create" });
  });

  it("時刻を読めないときは起票しない", () => {
    expect(
      decideDeployFailure({ run: run({ updatedAt: "壊れた値" }), tracked: null, now: NOW }),
    ).toEqual({ kind: "skip", reason: "within_grace" });
  });
});

describe("設定値の読み取り", () => {
  it("未設定・空文字・数値でない値では既定値に戻す", () => {
    expect(deployFailureSweepIntervalMinutes(undefined)).toBe(5);
    expect(deployFailureSweepIntervalMinutes("  ")).toBe(5);
    expect(deployFailureSweepIntervalMinutes("abc")).toBe(5);
    expect(deployFailureGraceMinutes(undefined)).toBe(10);
    expect(deployFailureGraceMinutes("-1")).toBe(10);
  });

  it("0は「巡回しない」「猶予なし」としてそのまま通す", () => {
    expect(deployFailureSweepIntervalMinutes("0")).toBe(0);
    expect(deployFailureGraceMinutes("0")).toBe(0);
  });
});

describe("Issueのタイトルと本文", () => {
  it("版が分かればタイトルに入れる", () => {
    expect(buildDeployFailureIssueTitle(meta())).toBe(
      "[デプロイ失敗] guchi-apps/myroom: v1.4.2の本番デプロイが失敗しました",
    );
  });

  it("版が分からないときは版を書かない", () => {
    expect(buildDeployFailureIssueTitle(meta({ version: null }))).toBe(
      "[デプロイ失敗] guchi-apps/myroom: 本番デプロイが失敗しました",
    );
  });

  it("本文に実行URL・失敗ジョブ・本番に残っている版を書く", () => {
    const body = buildDeployFailureIssueBody(meta());
    expect(body).toContain("https://github.com/guchi-apps/myroom/actions/runs/482");
    expect(body).toContain("`deploy`");
    expect(body).toContain("本番はv1.4.1のままです");
    expect(body).toContain("自動で1回やり直しても失敗");
  });

  it("初回の失敗では「やり直しても失敗」と書かない", () => {
    expect(buildDeployFailureIssueBody(meta({ attempt: 1 }))).not.toContain("やり直しても失敗");
  });

  it("本文へ埋めたマーカーを読み戻せる", () => {
    expect(parseDeployFailureMeta(buildDeployFailureIssueBody(meta()))).toEqual(meta());
  });
});

describe("parseDeployFailureMeta", () => {
  it("マーカーが無い本文ではnull", () => {
    expect(parseDeployFailureMeta("ふつうのIssueの本文")).toBeNull();
    expect(parseDeployFailureMeta(null)).toBeNull();
    expect(parseDeployFailureMeta(undefined)).toBeNull();
  });

  it("壊れたJSONはマーカー無しとして扱う（本文を手で編集して壊すことがある）", () => {
    expect(parseDeployFailureMeta("<!-- deploy-failure: {壊れている -->")).toBeNull();
  });

  it("必須の値が欠けていればnull", () => {
    expect(parseDeployFailureMeta('<!-- deploy-failure: {"version":"1.0.0"} -->')).toBeNull();
  });

  it("欠けている任意の値は既定へ倒す", () => {
    expect(
      parseDeployFailureMeta(
        '<!-- deploy-failure: {"repositoryFullName":"a/b","runUrl":"https://example.com/1"} -->',
      ),
    ).toEqual({
      repositoryFullName: "a/b",
      runId: 0,
      runUrl: "https://example.com/1",
      version: null,
      previousVersion: null,
      failedJobs: [],
      attempt: 1,
      detectedAt: "",
    });
  });
});
