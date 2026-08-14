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

/**
 * 一覧・詳細のヘッダーを描くのに必要なPR1件ぶんの情報。
 *
 * 一覧（`/api/pull-requests`）はマージ待ち（open）のPRしか返さないが、画面内のリンクから
 * 開くPRはマージ済み・クローズ済みでもありうる（#1260）。そのため`state`・`merged`を持ち、
 * 詳細（`/api/pull-requests/detail`）も同じ形をあわせて返す。
 */
export type PullRequestSummary = {
  /** 一覧のkey・選択状態に使う識別子（`<owner>/<repo>#<番号>`） */
  id: string;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  number: number;
  title: string;
  htmlUrl: string;
  authorLogin: string;
  draft: boolean;
  /** open（マージ待ち）かclosed（マージ済み・却下）か */
  state: "open" | "closed";
  /** マージ済みか。`state`がclosedのときだけtrueになりうる */
  merged: boolean;
  baseRef: string;
  headRef: string;
  kind: PullRequestKind;
  /** headブランチ名・タイトル・本文から推定した対応Issue番号。特定できなければnull */
  linkedIssueNumber: number | null;
  /** GitHubのAuto-mergeが有効か（＝CI通過後に自動でマージされる見込みか） */
  autoMergeEnabled: boolean;
  /** headコミットのcheck-runsを集約したCI状態。closedなPRでは取得せず`unknown` */
  ciState: CiState;
  createdAt: string;
  updatedAt: string;
};

export type OpenPullRequestsResponse = {
  pullRequests: PullRequestSummary[];
  /** 取得時刻（ISO8601）。一覧のヘッダーに「最終更新」として表示する */
  fetchedAt: string;
  /**
   * 取得に失敗したリポジトリのfullName。1件の失敗で一覧全体を落とさず、
   * 「取れていないリポジトリがある」ことだけを画面に出すために返す。
   */
  failedRepositories: string[];
};

/** PR詳細のタイムラインに並ぶ1件の種別 */
export type PullRequestEventKind =
  /** 会話タブのコメント（`gh pr comment`・画面からの投稿・botの通知） */
  | "comment"
  /** レビューの送信（Approve・変更要求・総評コメント） */
  | "review"
  /** 差分の行に紐づくレビューコメント */
  | "review-comment";

/** レビューの結果。GitHubの`state`（APPROVED等）を画面表示用に正規化したもの */
export type PullRequestReviewState = "approved" | "changes_requested" | "commented" | "dismissed";

/**
 * 会話コメント・レビュー・レビューコメントを同じ形に均した1件。取得元のエンドポイントは
 * 3つに分かれるが、画面では「PRで何が起きたか」を時系列に1本で読みたいため統合する。
 */
export type PullRequestEvent = {
  /** 種別ごとにID空間が別なので、種別を接頭辞に付けて一意にする（例: `comment-123`） */
  id: string;
  kind: PullRequestEventKind;
  authorLogin: string;
  body: string;
  createdAt: string;
  /** `review`のときのみ。Approveと変更要求を区別して表示する */
  reviewState: PullRequestReviewState | null;
  /** `review-comment`のときのみ。指摘対象のファイルパス */
  path: string | null;
  /** `review-comment`のときのみ。指摘対象の行。差分が古くなり特定できない場合はnull */
  line: number | null;
};

/**
 * PR1件の詳細。
 *
 * 元々は「タイトル・ブランチ・CI状態など一覧が既に持っているものは返さない」設計だったが、
 * 画面内のリンクから直接PRを開けるようにした結果、一覧に載っていないPR（マージ済み・
 * クローズ済み）を開く経路ができた（#1260）。その場合はヘッダーを描く材料が無いため、
 * `summary`をあわせて返す。一覧から開いた場合は一覧の項目を優先して使うので、
 * 表示が遅れることはない。
 */
export type PullRequestDetail = {
  /** 一覧の項目と対応づける識別子（`<owner>/<repo>#<番号>`） */
  id: string;
  /** ヘッダー表示用のPR情報。一覧を経由せず開いた場合はこれだけが手掛かりになる */
  summary: PullRequestSummary;
  /** PRの本文。未記入なら空文字 */
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  /** コンフリクトの有無。GitHubが判定中の場合はnull */
  mergeable: boolean | null;
  /** 時系列（古い順）に並べたコメント・レビュー */
  events: PullRequestEvent[];
};
