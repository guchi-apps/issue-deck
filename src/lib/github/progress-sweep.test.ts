import { describe, expect, it } from "vitest";

import {
  buildClosedStrandedRecoveredComment,
  buildDevelopMergedComment,
  buildStrandedComment,
  decideClosedStrandedIssue,
  decideProgressSweep,
  decideStaleCheckUser,
  hasDevelopMergedNotice,
  hasStrandedNotice,
  isManualStepTitle,
  needsStrandedCheck,
  progressSweepIntervalMinutes,
  PROGRESS_SWEEP_DEFAULT_INTERVAL_MINUTES,
  PROGRESS_SWEEP_STRANDED_GRACE_MINUTES,
  strandedCommentMarker,
  type ClosedStrandedFacts,
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

describe("decideStaleCheckUser", () => {
  const MERGED_AT = "2026-08-25T11:28:28Z";
  /** signaly#200の実測。11:27:25にラベルが付き、11:28:28にマージされた */
  const LABELED_BEFORE = new Date("2026-08-25T11:27:25Z");
  const LABELED_AFTER = new Date("2026-08-25T11:30:00Z");

  it("マージより前に付いた確認待ちなら外す（#2335。signaly#200の形）", () => {
    expect(
      decideStaleCheckUser({
        pullRequests: [{ state: "closed", mergedAt: MERGED_AT }],
        checkUserLabeledAt: LABELED_BEFORE,
      }),
    ).toEqual({ action: "clear", mergedAt: MERGED_AT });
  });

  it("マージより後に付いた確認待ちは外さない（判定前にマージされた場合の事後確認。#1968）", () => {
    expect(
      decideStaleCheckUser({
        pullRequests: [{ state: "closed", mergedAt: MERGED_AT }],
        checkUserLabeledAt: LABELED_AFTER,
      }),
    ).toEqual({ action: "skip", reason: "check_user_after_merge" });
  });

  it("比較の相手は最後のマージ。古いマージより後に付いたものは外さない", () => {
    expect(
      decideStaleCheckUser({
        pullRequests: [
          { state: "closed", mergedAt: "2026-08-20T00:00:00Z" },
          { state: "closed", mergedAt: MERGED_AT },
        ],
        checkUserLabeledAt: LABELED_AFTER,
      }),
    ).toEqual({ action: "skip", reason: "check_user_after_merge" });
  });

  it("開いているPRが1件でもあれば外さない（本物のマージ待ち）", () => {
    expect(
      decideStaleCheckUser({
        pullRequests: [
          { state: "closed", mergedAt: MERGED_AT },
          { state: "open", mergedAt: null },
        ],
        checkUserLabeledAt: LABELED_BEFORE,
      }),
    ).toEqual({ action: "skip", reason: "check_user_pr_open" });
  });

  it("PRが1件も無ければ外さない（人が手で付けた確認待ちを消さない）", () => {
    expect(decideStaleCheckUser({ pullRequests: [], checkUserLabeledAt: LABELED_BEFORE })).toEqual({
      action: "skip",
      reason: "check_user_no_merged_pr",
    });
  });

  it("closeされただけでマージされていないPRしか無ければ外さない", () => {
    expect(
      decideStaleCheckUser({
        pullRequests: [{ state: "closed", mergedAt: null }],
        checkUserLabeledAt: LABELED_BEFORE,
      }),
    ).toEqual({ action: "skip", reason: "check_user_no_merged_pr" });
  });

  it("付与の時刻が分からなければ外さない（DBの同期が追い付いていない可能性がある）", () => {
    expect(
      decideStaleCheckUser({
        pullRequests: [{ state: "closed", mergedAt: MERGED_AT }],
        checkUserLabeledAt: null,
      }),
    ).toEqual({ action: "skip", reason: "check_user_after_merge" });
  });
});

describe("decideClosedStrandedIssue", () => {
  function closedFacts(overrides: Partial<ClosedStrandedFacts> = {}): ClosedStrandedFacts {
    return {
      mergedPullRequest: MERGED,
      compareWithMain: { aheadBy: 0 },
      ...overrides,
    };
  }

  it("developへのマージ済みPRが無ければ見送る", () => {
    expect(decideClosedStrandedIssue(closedFacts({ mergedPullRequest: null }))).toEqual({
      action: "skip",
      reason: "closed_no_merged_pr",
    });
  });

  it("mainとの比較を取得できなければ次の巡回へ回す", () => {
    expect(decideClosedStrandedIssue(closedFacts({ compareWithMain: null }))).toEqual({
      action: "skip",
      reason: "closed_compare_unavailable",
    });
  });

  it("まだmainの祖先になっていなければ見送る（次のリリース待ち）", () => {
    expect(
      decideClosedStrandedIssue(closedFacts({ compareWithMain: { aheadBy: 3 } })),
    ).toEqual({ action: "skip", reason: "closed_not_in_main_yet" });
  });

  it("mainの祖先になっていればdoneへ進める", () => {
    expect(decideClosedStrandedIssue(closedFacts())).toEqual({
      action: "advance_done",
      pullRequestUrl: MERGED.url,
    });
  });
});

describe("buildClosedStrandedRecoveredComment", () => {
  it("PRのURLと発信元マーカーを含む", () => {
    const body = buildClosedStrandedRecoveredComment(MERGED.url);

    expect(body).toContain(MERGED.url);
    expect(body).toContain("<!-- issue-deck-source:progress-sweep -->");
  });
});
