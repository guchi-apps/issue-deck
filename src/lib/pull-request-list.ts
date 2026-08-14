import type { PullRequestSummary, PullRequestKind } from "@/types/pull-request";

/** Issue専用ブランチの命名規約（`scripts/start-issue.sh`が作成する`issue-<番号>`） */
const ISSUE_BRANCH_PATTERN = /^issue-(\d+)$/;

/** バージョンバンプPRのheadブランチ（`release-develop-to-main.yml`が作る`release/vX.Y.Z`） */
const VERSION_BUMP_BRANCH_PREFIX = "release/v";

/** タイトル・本文中の`#123`形式のIssue参照 */
const ISSUE_REFERENCE_PATTERN = /#(\d+)/;

/**
 * PRのbase/headブランチから種別を判定する。
 *
 * ブランチ名だけで判定できるのは、issue-deckのマルチエージェント運用がブランチ名の規約
 * （`issue-<番号>` / `release/vX.Y.Z` / `develop` / `main`）に依存しているため
 * （[docs/multi-agent/branching.md](../../docs/multi-agent/branching.md)）。規約から外れた
 * ブランチは`other`になるだけで、一覧からは落とさない。
 */
export function classifyPullRequest(pullRequest: {
  baseRef: string;
  headRef: string;
}): PullRequestKind {
  const { baseRef, headRef } = pullRequest;
  if (baseRef === "main" && headRef === "develop") return "release";
  if (headRef.startsWith(VERSION_BUMP_BRANCH_PREFIX)) return "version-bump";
  if (ISSUE_BRANCH_PATTERN.test(headRef)) return "issue";
  return "other";
}

/**
 * PRに対応するIssue番号を推定する。`issue-<番号>`ブランチ名を最優先し、規約から外れた
 * ブランチではタイトル→本文の順に最初の`#<番号>`参照を使う。特定できなければnull。
 *
 * Issue側の「対応PR」表示（`pull-request-link.ts`）がコメント本文のPR URLから逆方向に
 * 引くのに対し、こちらはPR側からIssueを引く。PR一覧はIssueのコメントを取得しないため、
 * 同じ対応関係を別の手掛かりで解決している。
 */
export function extractLinkedIssueNumber(pullRequest: {
  headRef: string;
  title: string;
  body: string | null;
}): number | null {
  const branchMatch = ISSUE_BRANCH_PATTERN.exec(pullRequest.headRef);
  if (branchMatch) return Number(branchMatch[1]);

  for (const text of [pullRequest.title, pullRequest.body ?? ""]) {
    const match = ISSUE_REFERENCE_PATTERN.exec(text);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * 作成が古い順（＝最も長くマージを待っている順）に並べる。作成日時が同じ場合は
 * リポジトリ名・PR番号で安定させる。
 */
export function sortOpenPullRequests(pullRequests: PullRequestSummary[]): PullRequestSummary[] {
  return [...pullRequests].sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (diff !== 0) return diff;
    const byRepo = a.repositoryFullName.localeCompare(b.repositoryFullName);
    return byRepo !== 0 ? byRepo : a.number - b.number;
  });
}

export type PullRequestRepositoryGroup = {
  repositoryFullName: string;
  repositoryPrivate: boolean;
  pullRequests: PullRequestSummary[];
};

/**
 * リポジトリごとにまとめる。グループの並び順は「そのリポジトリで最も古いPRの作成日時」の
 * 昇順で、リポジトリ名順ではない。滞留が長いリポジトリを上に出すため。
 */
export function groupPullRequestsByRepository(
  pullRequests: PullRequestSummary[],
): PullRequestRepositoryGroup[] {
  const groups = new Map<string, PullRequestRepositoryGroup>();
  for (const pullRequest of sortOpenPullRequests(pullRequests)) {
    const existing = groups.get(pullRequest.repositoryFullName);
    if (existing) {
      existing.pullRequests.push(pullRequest);
    } else {
      groups.set(pullRequest.repositoryFullName, {
        repositoryFullName: pullRequest.repositoryFullName,
        repositoryPrivate: pullRequest.repositoryPrivate,
        pullRequests: [pullRequest],
      });
    }
  }
  // sortOpenPullRequestsの結果を順に詰めているため、Mapの挿入順が既に「最も古いPRの順」になる。
  return [...groups.values()];
}

/**
 * issue-deckの画面からマージ操作を出してよいPRか。draft以外はすべて対象にする（#1087）。
 *
 * 以前はCI通過済み・Auto-merge無効のPRだけにボタンを出していたが、CIが落ちたPRを確認のうえ
 * マージする、Auto-mergeの完了を待たずに今すぐ入れる、といった操作のためだけにGitHubへ
 * 移動する必要があった。「そのままマージしてよいか」の判断材料は`mergeWarnings`が文言で返し、
 * 実行前に確認を挟む形にしている。draftだけはGitHub側がマージを受け付けないため対象外。
 *
 * 画面内のリンクからマージ済み・クローズ済みのPRも開けるようになったため（#1260）、
 * openでないPRも対象外にする。
 */
export function canMergeFromDeck(pullRequest: PullRequestSummary): boolean {
  return pullRequest.state === "open" && !pullRequest.draft;
}

/**
 * そのままマージすると意図しない結果になりうる状態の説明。空配列なら確認なしでマージしてよい。
 * 画面はこの内容を確認ダイアログに並べる。
 */
export function mergeWarnings(pullRequest: PullRequestSummary): string[] {
  const warnings: string[] = [];
  if (pullRequest.ciState === "failure") {
    warnings.push("CIが失敗しています。");
  } else if (pullRequest.ciState === "pending") {
    warnings.push("CIがまだ実行中です。");
  } else if (pullRequest.ciState === "unknown") {
    warnings.push("CIの状態を確認できていません。");
  }
  if (pullRequest.autoMergeEnabled) {
    warnings.push("Auto-mergeが有効です。待てばCI通過後に自動でマージされます。");
  }
  return warnings;
}
