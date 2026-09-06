import { describe, expect, it } from "vitest";

import type {
  ReleaseVerification,
  ReleaseVerificationRow,
} from "@/lib/github/release-verification";
import {
  applyIssueTitles,
  applyReviewVerdicts,
  pullRequestChangeIssueLabel,
  pullRequestChangeLabel,
  tallyChangeReviews,
  toPullRequestChanges,
  type PullRequestCommitSource,
} from "@/lib/pull-request-changes";

function mergeCommit(
  sha: string,
  pullRequestNumber: number,
  branch: string,
  title: string,
): PullRequestCommitSource {
  return {
    sha,
    message: `Merge pull request #${pullRequestNumber} from guchi-apps/${branch}\n\n${title}`,
  };
}

describe("toPullRequestChanges", () => {
  it("マージコミットだけを拾い、ブランチ名から対応Issueを取り出す", () => {
    const changes = toPullRequestChanges([
      { sha: "a1", message: "計画コメントのマーカーがずれたら落ちるテストを足す。" },
      mergeCommit("a2", 2077, "issue-2062", "自動マージ失敗時の理由を画面へ出す"),
    ]);

    expect(changes).toEqual([
      {
        id: "a2",
        pullRequestNumber: 2077,
        issueNumber: 2062,
        title: "自動マージ失敗時の理由を画面へ出す",
        kind: "issue",
      },
    ]);
  });

  it("新しい順に並べ替える（GitHubの応答は古い順）", () => {
    const changes = toPullRequestChanges([
      mergeCommit("a1", 2056, "issue-2049", "古い方"),
      mergeCommit("a2", 2077, "issue-2062", "新しい方"),
    ]);

    expect(changes.map((change) => change.title)).toEqual(["新しい方", "古い方"]);
  });

  it("バージョンバンプPRのマージは`version-bump`として区別する", () => {
    const changes = toPullRequestChanges([
      mergeCommit("a1", 2074, "release/v4.19.0", "v4.19.0をリリースする"),
    ]);

    expect(changes[0]).toMatchObject({ kind: "version-bump", issueNumber: null });
  });

  it("Issue番号を持たないブランチからのマージもPRとして残す", () => {
    const changes = toPullRequestChanges([mergeCommit("a1", 2100, "hotfix", "設定を直す")]);

    expect(changes[0]).toMatchObject({ pullRequestNumber: 2100, issueNumber: null, kind: "issue" });
  });

  it("マージコミットが1件も無ければ、コミットの件名をそのまま並べる（squash運用）", () => {
    const changes = toPullRequestChanges([
      { sha: "a1", message: "設定を直す (#2100)\n\n詳細" },
      { sha: "a2", message: "テストを足す" },
    ]);

    expect(changes).toEqual([
      {
        id: "a2",
        pullRequestNumber: null,
        issueNumber: null,
        title: "テストを足す",
        kind: "commit",
      },
      {
        id: "a1",
        pullRequestNumber: 2100,
        issueNumber: null,
        title: "設定を直す (#2100)",
        kind: "commit",
      },
    ]);
  });

  it("コミットが無ければ空配列を返す", () => {
    expect(toPullRequestChanges([])).toEqual([]);
  });
});

describe("applyIssueTitles", () => {
  it("対応Issueのタイトルが分かるものだけ差し替える", () => {
    const changes = toPullRequestChanges([
      mergeCommit("a1", 2077, "issue-2062", "自動マージ失敗時の理由を画面へ出す"),
      mergeCommit("a2", 2078, "issue-2065", "画像プレビューを閉じられるようにする"),
    ]);

    const applied = applyIssueTitles(
      changes,
      new Map([[2062, "自動マージ失敗時の理由表示機能の追加"]]),
    );

    expect(applied.map((change) => change.title)).toEqual([
      "画像プレビューを閉じられるようにする",
      "自動マージ失敗時の理由表示機能の追加",
    ]);
  });

  it("元の配列・要素を書き換えない（ETagキャッシュ由来の値を壊さないため）", () => {
    const changes = toPullRequestChanges([mergeCommit("a1", 2077, "issue-2062", "PRのタイトル")]);

    applyIssueTitles(changes, new Map([[2062, "Issueのタイトル"]]));

    expect(changes[0].title).toBe("PRのタイトル");
  });
});

describe("pullRequestChangeLabel", () => {
  it("行頭にはPR番号を出す（対応Issueが分かっていても主語はPR。#2843）", () => {
    const [withIssue] = toPullRequestChanges([mergeCommit("a1", 2077, "issue-2062", "タイトル")]);
    const [withoutIssue] = toPullRequestChanges([mergeCommit("a2", 2100, "hotfix", "タイトル")]);

    expect(pullRequestChangeLabel(withIssue)).toBe("#2077");
    expect(pullRequestChangeLabel(withoutIssue)).toBe("#2100");
  });

  it("PR番号を特定できない行だけIssue番号へ落とす", () => {
    const [commitOnly] = toPullRequestChanges([{ sha: "a1", message: "テストを足す" }]);

    expect(pullRequestChangeLabel({ ...commitOnly, issueNumber: 2062 })).toBe("#2062");
  });

  it("どちらも分からなければnull（行頭の番号を出さない）", () => {
    const [commitOnly] = toPullRequestChanges([{ sha: "a1", message: "テストを足す" }]);

    expect(pullRequestChangeLabel(commitOnly)).toBeNull();
  });
});

describe("pullRequestChangeIssueLabel", () => {
  it("行頭のPR番号に添える対応Issue番号を返す", () => {
    const [change] = toPullRequestChanges([mergeCommit("a1", 2077, "issue-2062", "タイトル")]);

    expect(pullRequestChangeIssueLabel(change)).toBe("Issue #2062");
  });

  it("行頭がIssue番号になっている行では二重に出さない", () => {
    const [commitOnly] = toPullRequestChanges([{ sha: "a1", message: "テストを足す" }]);

    expect(pullRequestChangeIssueLabel({ ...commitOnly, issueNumber: 2062 })).toBeNull();
  });
});

describe("applyReviewVerdicts", () => {
  function row(overrides: Partial<ReleaseVerificationRow> = {}): ReleaseVerificationRow {
    return {
      issueNumber: 2062,
      issueTitle: null,
      pullRequestNumber: 2077,
      reviewKind: "ok",
      reviewLabel: "問題なし（LGTM）",
      riskKind: "none",
      riskLabel: "該当なし",
      reviewBody: null,
      ...overrides,
    };
  }

  function verification(rows: ReleaseVerificationRow[]): ReleaseVerification {
    return {
      rows,
      tally: {
        total: rows.length,
        ok: 0,
        needsCheck: 0,
        changesRequested: 0,
        skipped: 0,
        unknown: 0,
      },
    };
  }

  it("PR番号で突き合わせる", () => {
    const changes = toPullRequestChanges([mergeCommit("a1", 2077, "issue-2062", "タイトル")]);

    const [applied] = applyReviewVerdicts(changes, verification([row()]));
    expect(applied.reviewKind).toBe("ok");
    expect(applied.reviewLabel).toBe("問題なし（LGTM）");
  });

  it("表の行にPR番号が無ければIssue番号で拾う", () => {
    const changes = toPullRequestChanges([mergeCommit("a1", 2077, "issue-2062", "タイトル")]);

    const [applied] = applyReviewVerdicts(
      changes,
      verification([row({ pullRequestNumber: null, reviewKind: "needs-check", reviewLabel: "要確認" })]),
    );
    expect(applied.reviewKind).toBe("needs-check");
  });

  it("見つからない行・表そのものが無い場合は落とさず「記録なし」にする", () => {
    const changes = toPullRequestChanges([mergeCommit("a1", 2077, "issue-2062", "タイトル")]);

    expect(applyReviewVerdicts(changes, null)).toEqual([
      { ...changes[0], reviewKind: "unknown", reviewLabel: "記録なし" },
    ]);
    expect(applyReviewVerdicts(changes, verification([row({ pullRequestNumber: 9999, issueNumber: 9999 })]))[0]
      .reviewKind).toBe("unknown");
  });

  it("バンプPRは必ず表に無いので、記録なしではなく「レビューなし」（実施なし）にする", () => {
    const changes = toPullRequestChanges([mergeCommit("a1", 2079, "release/v4.19.0", "v4.19.0をリリースする")]);

    const [applied] = applyReviewVerdicts(changes, null);
    // `skipped`は灰色で記号が`–`。危険信号ではなく「レビューの対象ではない」ことを表す
    expect(applied.reviewKind).toBe("skipped");
    expect(applied.reviewLabel).toBe("レビューなし");
  });
});

describe("tallyChangeReviews", () => {
  it("表の集計ではなく、並べた行から数える", () => {
    const changes = toPullRequestChanges([
      mergeCommit("a1", 2077, "issue-2062", "タイトル"),
      mergeCommit("a2", 2078, "issue-2063", "タイトル"),
      mergeCommit("a3", 2079, "release/v4.19.0", "バンプ"),
    ]);
    const applied = applyReviewVerdicts(changes, {
      rows: [
        {
          issueNumber: 2062,
          issueTitle: null,
          pullRequestNumber: 2077,
          reviewKind: "changes-requested",
          reviewLabel: "要修正",
          riskKind: "none",
          riskLabel: "該当なし",
          reviewBody: null,
        },
        {
          issueNumber: 2063,
          issueTitle: null,
          pullRequestNumber: 2078,
          reviewKind: "ok",
          reviewLabel: "問題なし",
          riskKind: "none",
          riskLabel: "該当なし",
          reviewBody: null,
        },
      ],
      // 表の集計はIssueを数えたもので、並べた行（PR）とは母数が違う
      tally: { total: 2, ok: 1, needsCheck: 0, changesRequested: 1, skipped: 0, unknown: 0 },
    });

    // バンプPRは母数から外す（毎リリース必ず1件の「実施なし」が積まれ、分母が実態とずれる）
    expect(tallyChangeReviews(applied)).toEqual({
      total: 2,
      ok: 1,
      needsCheck: 0,
      changesRequested: 1,
      skipped: 0,
      unknown: 0,
    });
  });
});
