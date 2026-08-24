import { describe, expect, it } from "vitest";

import {
  buildDevelopMergedComment,
  buildStrandedComment,
  decideProgressSweep,
  hasDevelopMergedNotice,
  hasStrandedNotice,
  isManualStepTitle,
  needsStrandedCheck,
  progressSweepIntervalMinutes,
  PROGRESS_SWEEP_DEFAULT_INTERVAL_MINUTES,
  PROGRESS_SWEEP_STRANDED_GRACE_MINUTES,
  strandedCommentMarker,
  type ProgressSweepFacts,
} from "@/lib/github/progress-sweep";

const NOW = new Date("2026-08-25T12:00:00Z");
const MERGED = { url: "https://github.com/guchi-apps/issue-deck/pull/1", headSha: "aaa111" };

/** 何分前のコミットか */
function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function facts(overrides: Partial<ProgressSweepFacts> = {}): ProgressSweepFacts {
  return {
    mergedPullRequest: MERGED,
    branchHead: MERGED.headSha,
    compare: null,
    hasOpenDevelopPullRequest: false,
    strandedNotified: false,
    ...overrides,
  };
}

describe("needsStrandedCheck", () => {
  it("先端が一致していれば比較まで見に行かない", () => {
    expect(needsStrandedCheck("aaa111", "aaa111")).toBe(false);
  });

  it("ブランチが消えていれば追加のpushは無いので見に行かない", () => {
    expect(needsStrandedCheck(null, "aaa111")).toBe(false);
  });

  it("先端が食い違うときだけ見に行く", () => {
    expect(needsStrandedCheck("bbb222", "aaa111")).toBe(true);
  });
});

describe("decideProgressSweep", () => {
  it("マージ済みPRが無ければ何もしない", () => {
    expect(decideProgressSweep(facts({ mergedPullRequest: null }), { now: NOW })).toEqual({
      action: "skip",
      reason: "no_merged_pr",
    });
  });

  it("マージ済みPRの先端とブランチの先端が一致すればDevelopへ進める", () => {
    expect(decideProgressSweep(facts(), { now: NOW })).toEqual({
      action: "advance",
      pullRequestUrl: MERGED.url,
    });
  });

  it("マージ後にブランチが削除されていれば、追加のpushが無い証拠として進める", () => {
    expect(decideProgressSweep(facts({ branchHead: null }), { now: NOW })).toEqual({
      action: "advance",
      pullRequestUrl: MERGED.url,
    });
  });

  it("先端が食い違うのに比較を取得できなければ、次の巡回へ回す", () => {
    const decision = decideProgressSweep(facts({ branchHead: "bbb222", compare: null }), {
      now: NOW,
    });

    expect(decision).toEqual({ action: "skip", reason: "compare_unavailable" });
  });

  it("developへ入っていないコミットが無ければ、先端が違っても進める", () => {
    const decision = decideProgressSweep(
      facts({
        branchHead: "bbb222",
        compare: { aheadBy: 0, changedFiles: 0, lastCommitAt: minutesAgo(5) },
      }),
      { now: NOW },
    );

    expect(decision).toEqual({ action: "advance", pullRequestUrl: MERGED.url });
  });

  it("コミットは残っていてもdevelopへ持ち込む変更が0件なら進める（#2289のコンフリクト解消マージ）", () => {
    const decision = decideProgressSweep(
      facts({
        branchHead: "bbb222",
        compare: { aheadBy: 2, changedFiles: 0, lastCommitAt: minutesAgo(1000) },
      }),
      { now: NOW },
    );

    expect(decision).toEqual({ action: "advance", pullRequestUrl: MERGED.url });
  });

  it("変更ファイル数を読めなかった場合は、従来どおり取り残しとして扱う", () => {
    const decision = decideProgressSweep(
      facts({
        branchHead: "bbb222",
        compare: { aheadBy: 2, changedFiles: null, lastCommitAt: minutesAgo(1000) },
      }),
      { now: NOW },
    );

    expect(decision).toMatchObject({ action: "notify_stranded", aheadBy: 2 });
  });

  it("develop向けPRが開いていれば実装中とみなして見送る", () => {
    const decision = decideProgressSweep(
      facts({
        branchHead: "bbb222",
        compare: { aheadBy: 1, changedFiles: 3, lastCommitAt: minutesAgo(1000) },
        hasOpenDevelopPullRequest: true,
      }),
      { now: NOW },
    );

    expect(decision).toEqual({ action: "skip", reason: "develop_pr_open" });
  });

  it("最後のコミットから猶予時間が経っていなければ様子を見る", () => {
    const decision = decideProgressSweep(
      facts({
        branchHead: "bbb222",
        compare: {
          aheadBy: 1,
          changedFiles: 3,
          lastCommitAt: minutesAgo(PROGRESS_SWEEP_STRANDED_GRACE_MINUTES - 1),
        },
      }),
      { now: NOW },
    );

    expect(decision).toEqual({ action: "skip", reason: "within_grace" });
  });

  it("猶予時間を過ぎたら取り残しとして通知する", () => {
    const decision = decideProgressSweep(
      facts({
        branchHead: "bbb222",
        compare: {
          aheadBy: 2,
          changedFiles: 3,
          lastCommitAt: minutesAgo(PROGRESS_SWEEP_STRANDED_GRACE_MINUTES + 30),
        },
      }),
      { now: NOW },
    );

    expect(decision).toEqual({
      action: "notify_stranded",
      pullRequestUrl: MERGED.url,
      pullRequestHeadSha: MERGED.headSha,
      branchHead: "bbb222",
      aheadBy: 2,
      ageMinutes: PROGRESS_SWEEP_STRANDED_GRACE_MINUTES + 30,
    });
  });

  it("同じ先端について通知済みなら重ねて通知しない", () => {
    const decision = decideProgressSweep(
      facts({
        branchHead: "bbb222",
        compare: { aheadBy: 2, changedFiles: 3, lastCommitAt: minutesAgo(1000) },
        strandedNotified: true,
      }),
      { now: NOW },
    );

    expect(decision).toEqual({ action: "skip", reason: "already_notified" });
  });

  it("コミット日時が読めなければ判定せず次の巡回へ回す", () => {
    const decision = decideProgressSweep(
      facts({
        branchHead: "bbb222",
        compare: { aheadBy: 2, changedFiles: 3, lastCommitAt: null },
      }),
      { now: NOW },
    );

    expect(decision).toEqual({ action: "skip", reason: "compare_unavailable" });
  });
});

describe("progressSweepIntervalMinutes", () => {
  it("未設定なら既定値", () => {
    expect(progressSweepIntervalMinutes(undefined)).toBe(PROGRESS_SWEEP_DEFAULT_INTERVAL_MINUTES);
    expect(progressSweepIntervalMinutes("")).toBe(PROGRESS_SWEEP_DEFAULT_INTERVAL_MINUTES);
  });

  it("数値でなければ既定値", () => {
    expect(progressSweepIntervalMinutes("abc")).toBe(PROGRESS_SWEEP_DEFAULT_INTERVAL_MINUTES);
    expect(progressSweepIntervalMinutes("-1")).toBe(PROGRESS_SWEEP_DEFAULT_INTERVAL_MINUTES);
  });

  it("0は「巡回しない」として通す", () => {
    expect(progressSweepIntervalMinutes("0")).toBe(0);
  });

  it("指定した値を使う", () => {
    expect(progressSweepIntervalMinutes("15")).toBe(15);
  });
});

describe("コメント本文", () => {
  it("マージ完了の通知は同じPRのURLで重複を見分けられる", () => {
    const body = buildDevelopMergedComment(MERGED.url);

    expect(hasDevelopMergedNotice([body], MERGED.url)).toBe(true);
    expect(hasDevelopMergedNotice([body], "https://github.com/guchi-apps/issue-deck/pull/2")).toBe(
      false,
    );
    expect(hasDevelopMergedNotice([null, "無関係なコメント"], MERGED.url)).toBe(false);
  });

  it("取り残しの通知は先端のSHAごとに重複を見分けられる", () => {
    const body = buildStrandedComment({
      issueNumber: 99,
      branchHead: "bbb222",
      pullRequestUrl: MERGED.url,
      pullRequestHeadSha: MERGED.headSha,
      aheadBy: 2,
      ageMinutes: 130,
    });

    expect(body).toContain(strandedCommentMarker(99, "bbb222"));
    expect(body).toContain("issue-99");
    expect(hasStrandedNotice([body], 99, "bbb222")).toBe(true);
    // 別のコミットがpushされれば改めて通知する
    expect(hasStrandedNotice([body], 99, "ccc333")).toBe(false);
  });
});

describe("isManualStepTitle", () => {
  it("[手作業]で始まるタイトルだけを拾う", () => {
    expect(isManualStepTitle("[手作業] VPS: .envを更新する")).toBe(true);
    expect(isManualStepTitle("手作業でVPSの.envを更新する")).toBe(false);
    expect(isManualStepTitle("対応の前に[手作業]が要る")).toBe(false);
  });
});
