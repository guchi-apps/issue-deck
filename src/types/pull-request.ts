import type { CiState } from "@/lib/github/release-api";

/** マージ待ちPRの種別。リポジトリ横断の一覧で「何を待っているPRか」を一目で区別するために使う */
export type PullRequestKind =
  /** develop → main のリリースPR（本番反映待ち） */
  | "release"
  /** release/vX.Y.Z → develop のバージョンバンプPR */
  | "version-bump"
  /** issue-<番号> ブランチからの実装PR */
  | "issue"
  /** 上記のいずれにも当てはまらないPR */
  | "other";

export type OpenPullRequest = {
  /** 一覧のkey・選択状態に使う識別子（`<owner>/<repo>#<番号>`） */
  id: string;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  number: number;
  title: string;
  htmlUrl: string;
  authorLogin: string;
  draft: boolean;
  baseRef: string;
  headRef: string;
  kind: PullRequestKind;
  /** headブランチ名・タイトル・本文から推定した対応Issue番号。特定できなければnull */
  linkedIssueNumber: number | null;
  /** GitHubのAuto-mergeが有効か（＝CI通過後に自動でマージされる見込みか） */
  autoMergeEnabled: boolean;
  /** headコミットのcheck-runsを集約したCI状態 */
  ciState: CiState;
  createdAt: string;
  updatedAt: string;
};

export type OpenPullRequestsResponse = {
  pullRequests: OpenPullRequest[];
  /** 取得時刻（ISO8601）。一覧のヘッダーに「最終更新」として表示する */
  fetchedAt: string;
  /**
   * 取得に失敗したリポジトリのfullName。1件の失敗で一覧全体を落とさず、
   * 「取れていないリポジトリがある」ことだけを画面に出すために返す。
   */
  failedRepositories: string[];
};
