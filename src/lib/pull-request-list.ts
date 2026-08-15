import type {
  PullRequestKind,
  PullRequestListScope,
  PullRequestSummary,
  PullRequestViewId,
} from "@/types/pull-request";

/** Issue専用ブランチの命名規約（`scripts/start-issue.sh`が作成する`issue-<番号>`） */
const ISSUE_BRANCH_PATTERN = /^issue-(\d+)$/;

/** バージョンバンプPRのheadブランチ（`release-develop-to-main.yml`が作る`release/vX.Y.Z`） */
const VERSION_BUMP_BRANCH_PREFIX = "release/v";

/** タイトル・本文中の`#123`形式のIssue参照 */
const ISSUE_REFERENCE_PATTERN_GLOBAL = /#(\d+)/g;

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
  return extractLinkedIssueNumbers(pullRequest)[0] ?? null;
}

/**
 * PRが参照しているIssue番号を、確度の高い順にすべて返す（#1455）。
 *
 * 1本のPRで複数のIssueに対応することがあるため、`extractLinkedIssueNumber`（先頭1件）では
 * 関連を取りこぼす。先頭は「そのブランチが何の作業か」を最もよく表すもの
 * （`issue-<番号>`ブランチ名 → タイトル → 本文の順）で、以降は同じ順で拾った参照。
 *
 * **本文中の`#番号`は単なる言及も混ざる**ため、2件目以降は「対応Issue」ではなく
 * 「関連Issue」として扱う（画面もその文言で出す）。
 */
export function extractLinkedIssueNumbers(pullRequest: {
  headRef: string;
  title: string;
  body: string | null;
}): number[] {
  const numbers: number[] = [];
  const add = (value: number) => {
    if (!numbers.includes(value)) numbers.push(value);
  };

  const branchMatch = ISSUE_BRANCH_PATTERN.exec(pullRequest.headRef);
  if (branchMatch) add(Number(branchMatch[1]));

  for (const text of [pullRequest.title, pullRequest.body ?? ""]) {
    for (const match of text.matchAll(ISSUE_REFERENCE_PATTERN_GLOBAL)) {
      add(Number(match[1]));
    }
  }
  return numbers;
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

/**
 * 更新が新しい順に並べる。更新日時が同じ場合はリポジトリ名・PR番号で安定させる。
 * マージ済みを含む「全てのPR」ビュー向け（#1312）。作成が古い順のままだと、何年も前に
 * 完了したPRが先頭を占めて履歴として読めなくなる。
 */
export function sortPullRequestsByUpdated(
  pullRequests: PullRequestSummary[],
): PullRequestSummary[] {
  return [...pullRequests].sort((a, b) => {
    const diff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (diff !== 0) return diff;
    const byRepo = a.repositoryFullName.localeCompare(b.repositoryFullName);
    return byRepo !== 0 ? byRepo : a.number - b.number;
  });
}

/**
 * ビューごとの絞り込み（#1312）。母集団の広さ（closedを取りに行くか）は
 * `scopeForPullRequestView`が決め、ここは受け取った一覧を絞るだけ。
 *
 * ドラフトとCI状態不明を`in-progress`側へ入れているのは、どちらも「まだ結果が確定していない」
 * ためにマージの判断ができない点で同じだから（ドラフトはCI状態を取得していないので常に`unknown`）。
 */
export function filterPullRequestsByView(
  pullRequests: PullRequestSummary[],
  view: PullRequestViewId,
): PullRequestSummary[] {
  if (view === "all") return pullRequests;
  return pullRequests.filter((pullRequest) => {
    if (pullRequest.state !== "open") return false;
    const completed = !pullRequest.draft && ["success", "failure"].includes(pullRequest.ciState);
    return view === "completed" ? completed : !completed;
  });
}

/** ビューを表示するために一覧APIへ要求する母集団（#1312） */
export function scopeForPullRequestView(view: PullRequestViewId): PullRequestListScope {
  return view === "all" ? "all" : "open";
}

/**
 * 左メニュー「Pull Request」セクションに出す件数（#1389）。`null`は「件数を出さない」。
 */
export type PullRequestNavCounts = Record<PullRequestViewId, number | null>;

/**
 * ビューごとの件数を数える（#1389）。Issue側の`computeNavCounts`と同じく、渡すのは
 * ビューの絞り込みを掛ける前・それ以外（リポジトリ絞り込みなど）は掛けた後の集合にする。
 * そうしないとメニューの件数と一覧の件数が食い違う。
 *
 * `null`になるのは次の2つ。
 *
 * - **未取得**（`loaded`がfalse）: PR一覧はDBキャッシュを持たず取得に時間がかかるため、
 *   取得前に`0`を出すと「PRが無い」と読めてしまう。
 * - **「全てのPR」**: 母集団が`scope`（open だけか、直近のクローズ済みまで含むか）に依存し、
 *   「全PR数」として読める数にならない。「処理中」「完了」の2つでopenなPRを過不足なく
 *   二分するので、件数としてはこの2つで足りる。
 *
 * 「処理中」「完了」は`filterPullRequestsByView`が`state === "open"`のPRしか通さないため、
 * 渡された集合がどちらの`scope`の取得結果でも同じ値になる。
 */
export function computePullRequestNavCounts(
  pullRequests: PullRequestSummary[],
  loaded: boolean,
): PullRequestNavCounts {
  if (!loaded) return { all: null, "in-progress": null, completed: null };
  return {
    all: null,
    "in-progress": filterPullRequestsByView(pullRequests, "in-progress").length,
    completed: filterPullRequestsByView(pullRequests, "completed").length,
  };
}

/** ビューごとの、リポジトリ内・リポジトリ間の並び順（#1312） */
export function sortPullRequestsForView(
  pullRequests: PullRequestSummary[],
  view: PullRequestViewId,
): PullRequestSummary[] {
  return view === "all"
    ? sortPullRequestsByUpdated(pullRequests)
    : sortOpenPullRequests(pullRequests);
}

export type PullRequestRepositoryGroup = {
  repositoryFullName: string;
  repositoryPrivate: boolean;
  pullRequests: PullRequestSummary[];
};

/**
 * リポジトリごとにまとめる。グループの並び順はリポジトリ名順ではなく、`view`が決める並びで
 * 最初に来るPRを持つリポジトリから順に並ぶ。マージ待ち系のビューは「最も古いPRの作成日時」の
 * 昇順で、滞留が長いリポジトリを上に出す。「全てのPR」だけは更新が新しい順。
 */
export function groupPullRequestsByRepository(
  pullRequests: PullRequestSummary[],
  view: PullRequestViewId,
): PullRequestRepositoryGroup[] {
  const groups = new Map<string, PullRequestRepositoryGroup>();
  for (const pullRequest of sortPullRequestsForView(pullRequests, view)) {
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
  // 並べ替え済みの結果を順に詰めているため、Mapの挿入順が既にグループの並び順になる。
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
