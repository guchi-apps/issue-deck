import { describe, expect, it } from "vitest";

import {
  applyIssueTitles,
  pullRequestChangeLabel,
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
  it("対応Issueが分かればIssue番号、分からなければPR番号を出す", () => {
    const [withIssue] = toPullRequestChanges([mergeCommit("a1", 2077, "issue-2062", "タイトル")]);
    const [withoutIssue] = toPullRequestChanges([mergeCommit("a2", 2100, "hotfix", "タイトル")]);

    expect(pullRequestChangeLabel(withIssue)).toBe("#2062");
    expect(pullRequestChangeLabel(withoutIssue)).toBe("#2100");
  });

  it("どちらも分からなければnull（行頭の番号を出さない）", () => {
    const [commitOnly] = toPullRequestChanges([{ sha: "a1", message: "テストを足す" }]);

    expect(pullRequestChangeLabel(commitOnly)).toBeNull();
  });
});
