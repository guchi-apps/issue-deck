/**
 * リリースの作り直し（#3014）。
 *
 * mainへのリリースPR（`release-main/vX.Y.Z`）は凍結ブランチなので、出した後に見つかった修正は
 * そこへ足せない。修正をdevelopへ入れたうえで画面の「修正を入れて作り直す」を押すと、
 * リリースPRを閉じてリリースworkflowを起動し直し、workflowが前回のバンプを取り消して
 * バンプからやり直す（`reusable-release-develop-to-main.yml`の「リリース状態を判定する」）。
 *
 * ここにあるのは、**リリースPRの後にdevelopへ入った変更**を画面へ出すための整形だけ。
 * 作り直すかどうかの最終的な判定はworkflow側が持つ（画面で押せても、workflowが
 * 「バンプ後に変更が無い」と見れば従来どおり同じ版のリリースPRを作り直すだけになる）。
 */

/** リリースPRの後にdevelopへ入ったPR1件 */
export type ReleaseRebuildPullRequest = {
  number: number;
  title: string;
  /** ブランチ名`issue-<番号>`から取れた対応Issue。取れなければnull */
  issueNumber: number | null;
};

/** リリースPRの後にdevelopへ入った変更。作り直しボタンの可否と確認ダイアログに使う */
export type ReleaseRebuildCandidate = {
  /** リリースPRのheadからdevelopまでのコミット数（マージコミットを含む） */
  aheadBy: number;
  /** そのうちPRのマージとして読み取れたもの（バンプPRは除く） */
  pullRequests: ReleaseRebuildPullRequest[];
};

/** `GET /repos/{owner}/{repo}/compare/{base}...{head}`の`commits[]`のうち使う部分 */
export type CompareCommit = { commit: { message: string } };

const MERGE_SUBJECT = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/;

/**
 * 比較結果のコミットから、developへマージされたPRを取り出す。
 *
 * GitHubの既定のマージコミットは件名が`Merge pull request #N from <owner>/<branch>`、
 * 本文の1行目がPRのタイトル。**バンプPR（`release/v…`）は除く**——作り直しで取り消す側なので、
 * 「新たに入る変更」として並べると意味が逆になる。
 */
export function parseRebuildPullRequests(commits: CompareCommit[]): ReleaseRebuildPullRequest[] {
  const pullRequests: ReleaseRebuildPullRequest[] = [];
  for (const { commit } of commits) {
    const [subject = "", ...rest] = commit.message.split("\n");
    const match = MERGE_SUBJECT.exec(subject);
    if (!match) continue;
    const branch = match[2];
    if (branch.startsWith("release/v") || branch.startsWith("release-main/v")) continue;
    const title = rest.map((line) => line.trim()).find((line) => line !== "") ?? subject;
    const issueMatch = /^issue-(\d+)$/.exec(branch);
    pullRequests.push({
      number: Number(match[1]),
      title,
      issueNumber: issueMatch ? Number(issueMatch[1]) : null,
    });
  }
  return pullRequests.sort((a, b) => a.number - b.number);
}

/** 作り直しボタンを押せるか。**developに新しいコミットが無ければ押せない**（中身が変わらない） */
export function canRebuildRelease(candidate: ReleaseRebuildCandidate | null): boolean {
  return candidate !== null && candidate.aheadBy > 0;
}

/**
 * 作り直しで閉じるリリースPRへ残すコメント。後からPRを開いた人が「なぜマージされずに
 * 閉じたのか」「どこで作り直されたのか」を読めるようにする。
 */
export function releaseRebuildCloseComment(candidate: ReleaseRebuildCandidate | null): string {
  const lines = [
    "issue-deckの「修正を入れて作り直す」でこのリリースPRを閉じました（#3014）。",
    "",
    "このPRの版は本番へ出ていないため欠番にし、developの最新の内容でバージョンバンプから作り直します。新しいバンプPRがdevelopへ自動マージされると、新しいリリースPRが作られます。",
  ];
  if (candidate && candidate.pullRequests.length > 0) {
    lines.push("", "新たに含まれる変更:");
    for (const pr of candidate.pullRequests) {
      lines.push(`- #${pr.number} ${pr.title}${pr.issueNumber ? `（Issue #${pr.issueNumber}）` : ""}`);
    }
  }
  return lines.join("\n");
}
