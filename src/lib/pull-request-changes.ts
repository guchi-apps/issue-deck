import type {
  ReleaseVerification,
  ReleaseVerificationRow,
  ReleaseVerificationTally,
  ReviewVerdictKind,
} from "@/lib/github/release-verification";
import type { PullRequestChange } from "@/types/pull-request";

/** 解析に使うコミット1件。GitHubの応答（`GithubApiPullRequestCommit`）から必要な2つだけを抜いたもの */
export type PullRequestCommitSource = {
  sha: string;
  /** コミットメッセージ全文（1行目が件名、空行を挟んだ以降が本文） */
  message: string;
};

/** `Merge pull request #2077 from guchi-apps/issue-2062` */
const MERGE_COMMIT_SUBJECT = /^Merge pull request #(\d+) from [^\s/]+\/(\S+)/;

/** squash mergeの既定の件名（`タイトル (#2077)`） */
const SQUASH_COMMIT_SUBJECT = /\(#(\d+)\)\s*$/;

/**
 * Issueごとの作業ブランチ（`issue-2062`）。
 * [docs/multi-agent/branching.md](../../docs/multi-agent/branching.md)
 */
const ISSUE_BRANCH = /^issue-(\d+)$/;

/** バージョンバンプのブランチ（`release/v4.19.0`） */
const VERSION_BUMP_BRANCH = /^release\/v/;

function splitMessage(message: string): { subject: string; body: string } {
  const lines = message.split("\n");
  return { subject: lines[0]?.trim() ?? "", body: lines.slice(1).join("\n").trim() };
}

/**
 * PRのコミットから「このマージに含まれる変更」の一覧を組み立てる（#2080）。
 *
 * develop→mainのリリースPRは、developへ入った各PRのマージコミットと、そのPRが持ち込んだ
 * 個々のコミットが混ざった数十件になる。**そのまま並べても「何を本番へ出すのか」は読めない**ので、
 * マージコミット（`Merge pull request #<番号> from <owner>/<ブランチ>`）だけを拾って
 * PR単位へ畳む。ブランチ名が`issue-<番号>`なら対応Issueまで辿れる。
 *
 * **マージコミットが1件も無いリポジトリ（squash運用）では、コミットの件名をそのまま並べる。**
 * 畳めないからといって何も出さないと、squash運用のリポジトリだけ確認材料がゼロになるため。
 * 件名が`… (#2077)`で終わるGitHubのsquash既定形式なら、そこからPR番号だけは拾う。
 *
 * 並びは新しい順（GitHubの応答は古い順）。`title`はこの時点ではコミットから読める文言で、
 * 対応Issueのタイトルが分かる場合は`applyIssueTitles`で差し替える。
 */
export function toPullRequestChanges(
  commits: readonly PullRequestCommitSource[],
): PullRequestChange[] {
  const merges: PullRequestChange[] = [];

  for (const commit of commits) {
    const { subject, body } = splitMessage(commit.message);
    const matched = subject.match(MERGE_COMMIT_SUBJECT);
    if (!matched) continue;

    const branch = matched[2];
    const issueMatched = branch.match(ISSUE_BRANCH);
    merges.push({
      id: commit.sha,
      pullRequestNumber: Number(matched[1]),
      issueNumber: issueMatched ? Number(issueMatched[1]) : null,
      // マージコミットの本文にはGitHubが既定でPRのタイトルを入れる。空なら件名で代替する
      title: body || subject,
      kind: VERSION_BUMP_BRANCH.test(branch) ? "version-bump" : "issue",
    });
  }

  if (merges.length > 0) return merges.reverse();

  return commits
    .map((commit) => {
      const { subject } = splitMessage(commit.message);
      const matched = subject.match(SQUASH_COMMIT_SUBJECT);
      return {
        id: commit.sha,
        pullRequestNumber: matched ? Number(matched[1]) : null,
        issueNumber: null,
        title: subject,
        kind: "commit" as const,
      };
    })
    .reverse();
}

/**
 * 対応Issueのタイトルが分かるものを差し替える（#2080）。
 *
 * **PRのタイトルより対応Issueのタイトルを優先する。** PRのタイトルは「何をどう直したか」を
 * 書いた実装側の文で長く、リリース前に読みたいのは「どの依頼が本番へ出るのか」のため。
 * タイトルが分からないIssue（キャッシュに無い・別リポジトリ）はPR由来の文言のまま残す。
 */
export function applyIssueTitles(
  changes: readonly PullRequestChange[],
  titleByIssueNumber: ReadonlyMap<number, string>,
): PullRequestChange[] {
  return changes.map((change) => {
    const title = change.issueNumber === null ? null : titleByIssueNumber.get(change.issueNumber);
    return title ? { ...change, title } : { ...change };
  });
}

/**
 * 一覧の行頭に出す番号。**Pull Requestの番号を先に出す**（#2843）。
 *
 * 以前は対応Issueの番号を先に出していた（#2080）が、コードレビューが走る単位はPull Requestで、
 * 判定もPRに紐づく。行頭がIssue番号のままだと「この判定はどのPRのものか」を読み替えることに
 * なるため、行の主語をPRへ移した。対応Issue番号は`pullRequestChangeIssueLabel`で行の中に残す。
 */
export function pullRequestChangeLabel(change: PullRequestChange): string | null {
  if (change.pullRequestNumber !== null) return `#${change.pullRequestNumber}`;
  if (change.issueNumber !== null) return `#${change.issueNumber}`;
  return null;
}

/**
 * 行頭のPR番号に添える対応Issue番号（#2843）。行頭がPR番号になっていない行（PR番号を
 * 特定できずIssue番号を出している行）では二重に出さないためnullを返す。
 */
export function pullRequestChangeIssueLabel(change: PullRequestChange): string | null {
  if (change.pullRequestNumber === null || change.issueNumber === null) return null;
  return `Issue #${change.issueNumber}`;
}

/** 変更1件と、そのPRの自動レビュー判定（#2843） */
export type PullRequestChangeReview = PullRequestChange & {
  reviewKind: ReviewVerdictKind;
  /** 表のセルにあった文言。記録が無い行は「レビューなし」 */
  reviewLabel: string;
};

/** 判定の記録が無い行の文言。**灰色で出す**——危険信号ではない */
const NO_REVIEW_LABEL = "レビューなし";

/**
 * リリースPR本文の検証結果を、含まれる変更の各行へ突き合わせる（#2843）。
 *
 * **突き合わせの鍵はPR番号。** 表の行はIssue番号を主語に作られているが、PR番号の列も持って
 * いる（`ReleaseVerificationRow.pullRequestNumber`）ので、レビューが走った単位そのもので
 * 結び付けられる。PR番号が空の行だけIssue番号で拾う。
 *
 * **見つからない行は落とさず「レビューなし」にする。** 表そのものが無いリリース（古いPR・
 * 自動レビューを持たないリポジトリ）でも変更一覧は今までどおり出す必要があり、
 * 判定の欄だけが灰色になる。
 */
export function applyReviewVerdicts(
  changes: readonly PullRequestChange[],
  verification: ReleaseVerification | null,
): PullRequestChangeReview[] {
  const byPullRequest = new Map<number, ReleaseVerificationRow>();
  const byIssue = new Map<number, ReleaseVerificationRow>();
  for (const row of verification?.rows ?? []) {
    if (row.pullRequestNumber !== null) byPullRequest.set(row.pullRequestNumber, row);
    byIssue.set(row.issueNumber, row);
  }

  return changes.map((change) => {
    const row =
      (change.pullRequestNumber !== null ? byPullRequest.get(change.pullRequestNumber) : undefined) ??
      (change.issueNumber !== null ? byIssue.get(change.issueNumber) : undefined);
    return {
      ...change,
      reviewKind: row?.reviewKind ?? "unknown",
      reviewLabel: row?.reviewLabel ?? NO_REVIEW_LABEL,
    };
  });
}

/**
 * 並べた行の判定を数える（#2843）。**表そのものの集計（`ReleaseVerification.tally`）は使わない**
 * ——あちらはIssueを数えたもので、画面に並ぶ行（PR）とは母数が違う。「5本のうち1本が要修正」を
 * 出すための数なので、出している行から数える。
 */
export function tallyChangeReviews(
  changes: readonly PullRequestChangeReview[],
): ReleaseVerificationTally {
  const count = (kind: ReviewVerdictKind) =>
    changes.filter((change) => change.reviewKind === kind).length;
  return {
    total: changes.length,
    ok: count("ok"),
    needsCheck: count("needs-check"),
    changesRequested: count("changes-requested"),
    skipped: count("skipped"),
    unknown: count("unknown"),
  };
}
