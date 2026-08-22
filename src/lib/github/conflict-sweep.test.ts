import { describe, expect, it } from "vitest";

import {
  CONFLICT_SWEEP_DEFAULT_INTERVAL_MINUTES,
  CONFLICT_SWEEP_RETRY_COOLDOWN_MINUTES,
  conflictSweepIntervalMinutes,
  decideConflictSweep,
  type ConflictSweepPullRequest,
} from "@/lib/github/conflict-sweep";
import { CONFLICT_RESOLVE_WORKFLOW_FILE } from "@/lib/github/pull-request-repair";
import { REPAIR_RUN_STALE_MINUTES } from "@/lib/github/pull-request-repair-run";

const NOW = new Date("2026-08-22T12:00:00Z");

function pullRequest(overrides: Partial<ConflictSweepPullRequest> = {}): ConflictSweepPullRequest {
  return {
    repositoryFullName: "guchi-apps/myroom",
    number: 191,
    baseRef: "develop",
    headRef: "issue-109",
    state: "open",
    draft: false,
    mergeable: false,
    checkUser: false,
    ...overrides,
  };
}

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

describe("decideConflictSweep", () => {
  it("コンフリクトしているdevelop向けのissue-<番号>PRはコンフリクト解消ワークフローを起動する", () => {
    expect(decideConflictSweep(pullRequest(), { repairRun: null, now: NOW })).toEqual({
      dispatch: true,
      target: {
        workflowFile: CONFLICT_RESOLVE_WORKFLOW_FILE,
        ref: "develop",
        inputs: { issue_number: "109" },
      },
    });
  });

  it("コンフリクトしていなければ起動しない", () => {
    expect(
      decideConflictSweep(pullRequest({ mergeable: true }), { repairRun: null, now: NOW }),
    ).toEqual({ dispatch: false, reason: "not_conflicting" });
  });

  it("コンフリクト判定が未計算（null）のあいだは起動しない", () => {
    // 「判定前イコールコンフリクトなし」ではなく「まだ動かさない」。次の巡回で拾い直す。
    expect(
      decideConflictSweep(pullRequest({ mergeable: null }), { repairRun: null, now: NOW }),
    ).toEqual({ dispatch: false, reason: "not_conflicting" });
  });

  it("ドラフト・クローズ済みのPRは対象外", () => {
    expect(
      decideConflictSweep(pullRequest({ draft: true }), { repairRun: null, now: NOW }),
    ).toEqual({ dispatch: false, reason: "not_repairable" });
    expect(
      decideConflictSweep(pullRequest({ state: "closed" }), { repairRun: null, now: NOW }),
    ).toEqual({ dispatch: false, reason: "not_repairable" });
  });

  it("Issueに紐づかないPR（develop→mainのリリースPR）は巡回の対象外", () => {
    // `claude-pr-repair.yml`は意図的に自動検知の経路を持たない（毎回人が押す前提）。
    expect(
      decideConflictSweep(pullRequest({ baseRef: "main", headRef: "develop" }), {
        repairRun: null,
        now: NOW,
      }),
    ).toEqual({ dispatch: false, reason: "no_auto_workflow" });
  });

  it("バンプPR（release/vX.Y.Z → develop）も巡回の対象外", () => {
    expect(
      decideConflictSweep(pullRequest({ headRef: "release/v4.22.0" }), {
        repairRun: null,
        now: NOW,
      }),
    ).toEqual({ dispatch: false, reason: "no_auto_workflow" });
  });

  it("対応Issueが00.check-userなら起動しない", () => {
    // 自動解消を断念したワークフローが付けたラベル。同じ理由で断念するだけなので繰り返さない。
    expect(
      decideConflictSweep(pullRequest({ checkUser: true }), { repairRun: null, now: NOW }),
    ).toEqual({ dispatch: false, reason: "check_user" });
  });

  it("同じPRのコンフリクト解消が走っている間は起動しない", () => {
    expect(
      decideConflictSweep(pullRequest(), {
        repairRun: { status: "running", startedAt: minutesAgo(3) },
        now: NOW,
      }),
    ).toEqual({ dispatch: false, reason: "repair_running" });
  });

  it("実行中の記録が失効していれば、待ち時間を過ぎている限り起動する", () => {
    expect(
      decideConflictSweep(pullRequest(), {
        repairRun: { status: "running", startedAt: minutesAgo(REPAIR_RUN_STALE_MINUTES + 1) },
        now: NOW,
      }).dispatch,
    ).toBe(true);
  });

  it("直前の起動から待ち時間が経っていなければ起動しない", () => {
    expect(
      decideConflictSweep(pullRequest(), {
        repairRun: {
          status: "finished",
          startedAt: minutesAgo(CONFLICT_SWEEP_RETRY_COOLDOWN_MINUTES - 1),
        },
        now: NOW,
      }),
    ).toEqual({ dispatch: false, reason: "cooldown" });
  });

  it("待ち時間を過ぎていれば再び起動する", () => {
    expect(
      decideConflictSweep(pullRequest(), {
        repairRun: {
          status: "finished",
          startedAt: minutesAgo(CONFLICT_SWEEP_RETRY_COOLDOWN_MINUTES + 1),
        },
        now: NOW,
      }).dispatch,
    ).toBe(true);
  });
});

describe("conflictSweepIntervalMinutes", () => {
  it("未設定・空文字は既定値", () => {
    expect(conflictSweepIntervalMinutes(undefined)).toBe(CONFLICT_SWEEP_DEFAULT_INTERVAL_MINUTES);
    expect(conflictSweepIntervalMinutes("  ")).toBe(CONFLICT_SWEEP_DEFAULT_INTERVAL_MINUTES);
  });

  it("0は「巡回しない」としてそのまま返す", () => {
    expect(conflictSweepIntervalMinutes("0")).toBe(0);
  });

  it("数値でない・負の値は既定値へ倒す", () => {
    expect(conflictSweepIntervalMinutes("abc")).toBe(CONFLICT_SWEEP_DEFAULT_INTERVAL_MINUTES);
    expect(conflictSweepIntervalMinutes("-5")).toBe(CONFLICT_SWEEP_DEFAULT_INTERVAL_MINUTES);
  });

  it("指定された分数を使う", () => {
    expect(conflictSweepIntervalMinutes("10")).toBe(10);
  });
});
