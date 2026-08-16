export type IssueState = "open" | "closed";

export type IssueStateReason = "completed" | "not_planned" | "reopened" | null;

export type GithubUser = {
  login: string;
};

export type IssueLabel = {
  name: string;
  color: string;
  description: string | null;
};

export type LabelSummary = {
  name: string;
  color: string;
  count: number;
};

export type IssueComment = {
  id: string;
  author: GithubUser;
  createdAtLabel: string;
  body: string;
  reactionCount: number;
};

export type IssueMilestone = {
  name: string;
  progressPercent: number;
};

/**
 * 親子関係で結ばれたIssue1件。`GET /api/issues/sub-issues`が返す。
 *
 * 番号・タイトル・stateはGitHub（ネイティブのサブIssue関係）から、`projectStatus`だけを
 * ローカルDBのキャッシュから合流させている。DBに無い相手（同期対象外・古すぎてキャッシュに
 * 載っていない）でもリンクとタイトルは欠けない。
 */
export type SubIssue = {
  number: number;
  title: string;
  state: IssueState;
  htmlUrl: string;
  /**
   * その親子が置かれているリポジトリ（`owner/repo`）。**サブIssueはリポジトリをまたげる**ため、
   * 番号だけでは相手を特定できない（#1722）。表示のキーも進捗の引き当ても、ここまで含めて突き合わせる
   */
  repositoryFullName: string;
  /**
   * GitHub Projects v2のStatus。DBキャッシュに無い場合はnull。
   * 進捗の判定は@/lib/issue-progressのresolveProgressStatusを通すこと
   */
  projectStatus: string | null;
};

/** 選択中のIssueから見た親子関係。どちらも無い場合がふつうにある */
export type SubIssueRelations = {
  parent: SubIssue | null;
  children: SubIssue[];
  /** GitHub上の子の総数。`children.length`より多い場合、取得しきれていない分がある */
  childCount: number;
};

export type Issue = {
  id: string;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  stateReason: IssueStateReason;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  repositoryArchived: boolean;
  author: GithubUser;
  assignee: GithubUser | null;
  labels: IssueLabel[];
  milestone: IssueMilestone | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  /** closeされた日時（ISO8601）。openなIssueはnull */
  closedAt: string | null;
  /** 00.check-userラベルが最後に付与された日時（ISO8601）。未付与・解除済みはnull */
  checkUserLabeledAt: string | null;
  /**
   * 「Claudeに質問する」ダイアログ経由の質問コメントが投稿された日時（ISO8601）。
   * 対応する回答コメントが投稿されると解除されnullに戻る。一覧向けのDBキャッシュ由来の
   * 近似値（詳細画面ではコメント全件から@/lib/github/ask-claudeのisQaAnswerPendingで
   * 正確に算出する）
   */
  qaAnswerPendingAt: string | null;
  /** 実際に最後にコメントが投稿された日時（ISO8601）。Webhook経由で未取得の場合はnull */
  lastCommentAt: string | null;
  /**
   * サブPCへ積んだ実行ジョブ（#1179）が未完了の間だけ入る、積んだ日時（ISO8601）。
   * 対象は`DispatchJob.activeKey`が入っている間＝QUEUED・CLAIMED・RUNNING（#1347）。
   *
   * 順番待ちの間、進捗Statusはセッションが起動して報告するまで`Ready`のままなので、
   * これが無いと「未着手」ビューに居座る。値を入れるのはジョブを引く側
   * （@/lib/issues-for-user・@/lib/github/sync-issues）で、マッパーの既定はnull
   */
  dispatchPendingAt: string | null;
  /**
   * GitHub Projects v2のStatus（例: "Implementation"）。Projectに未登録のIssueはnull。
   * 進捗状態を判定するときはこの値を直接見ず、@/lib/issue-progressのresolveProgressStatusを
   * 通すこと（Statusがnullなら進捗ラベルへフォールバックする）
   */
  projectStatus: string | null;
  htmlUrl: string;
  favorite: boolean;
  hasUnreadComments: boolean;
  /** ユーザーが最後に読んだ時点でのコメント総数。「ページ下部へ移動」ボタンで最初の未読コメントへ移動するために使う */
  readCommentCount: number;
};

/**
 * 運用ラベル（00.check-userやワークフロー状況ラベル）・進捗Status・Issueの性質で
 * 絞り込む定型ビューのID。「自分の担当」などのビューと同じくviewクエリで表現し、
 * URLの持ち方を揃える。
 *
 * 名前のとおりラベル起点で始まったが、進捗ラベルの廃止（#991 Phase 5）でStatus起点の
 * ビューが加わり、`question`（#1514）はタイトル接頭辞で判定する。判定材料はビューごとに
 * 異なるが、URLと件数の扱いを揃えるため同じ枠にまとめている。
 */
export const LABEL_NAV_VIEW_IDS = [
  "check-user",
  "manual-step",
  "question",
  "not-started",
  "in-progress",
  "release-pending",
  "recently-merged",
] as const;

export type LabelNavViewId = (typeof LABEL_NAV_VIEW_IDS)[number];

export const NAV_VIEW_IDS = [
  "all",
  "favorites",
  "recently-added",
  ...LABEL_NAV_VIEW_IDS,
] as const;

export type NavViewId = (typeof NAV_VIEW_IDS)[number];

/** スマホのホーム画面の先頭に出すカード1枚（#1690。`computeOverviewStats`が組み立てる） */
export type OverviewStat = {
  label: string;
  value: string;
  /** カードをタップしたときに開くビュー */
  linkedView: NavViewId;
};
