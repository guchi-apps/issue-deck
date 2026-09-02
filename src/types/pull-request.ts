import type { CheckUserReason } from "@/lib/github/approval-labels";
import type { MergeJudgement, RollupCiCheck } from "@/lib/github/check-rollup";
import type { PullRequestCiStatus } from "@/lib/github/pull-request-ci";
import type { RepairWorkflowAvailability } from "@/lib/github/pull-request-repair";
import type { PullRequestRepairRunSummary } from "@/lib/github/pull-request-repair-run";
import type { CiState } from "@/lib/github/release-api";
import type { DeployFailureIssueRef } from "@/types/branch-flow";

/** CIの内訳に並べるチェック1件（#2777）。中身は`RollupCiCheck`そのもの */
export type PullRequestCiCheck = RollupCiCheck;

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
 * 一覧（`/api/pull-requests`）は既定ではマージ待ち（open）のPRしか返さないが、画面内のリンクから
 * 開くPRはマージ済み・クローズ済みでもありうる（#1260）し、「全てのPR」ビューでは一覧にも
 * closedが載る（#1312）。そのため`state`・`merged`を持ち、
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
  /**
   * マージされた時刻（ISO8601）。マージされていなければnull。
   *
   * 「どのリリースに乗ったか」の判定に使う（#1455）。作業PRがdevelopへ入った時刻と、
   * develop→mainのリリースPRがマージされた時刻を比べれば、追加のAPI呼び出し無しに
   * 「その変更がどのバージョンで本番へ出たか」が分かる。
   */
  mergedAt: string | null;
  baseRef: string;
  headRef: string;
  kind: PullRequestKind;
  /** headブランチ名・タイトル・本文から推定した対応Issue番号。特定できなければnull */
  linkedIssueNumber: number | null;
  /**
   * このPRが参照しているIssue番号を確度の高い順に並べたもの（#1455）。先頭は
   * `linkedIssueNumber`と同じで、2件目以降は1本のPRで複数のIssueを扱った場合の残り。
   * **本文の`#番号`には単なる言及も混ざる**ため、2件目以降は「関連」として扱う。
   */
  linkedIssueNumbers: number[];
  /** GitHubのAuto-mergeが有効か（＝CI通過後に自動でマージされる見込みか） */
  autoMergeEnabled: boolean;
  /**
   * 対応Issue（`linkedIssueNumber`）に`00.check-user`が付いているか。対応Issueを特定できない
   * 場合・DBキャッシュに無い場合は`false`。
   *
   * develop向けPRを「自動マージしてよい」「ユーザーのマージが必要」のどちらかへ確定させるのは
   * `claude-review-develop.yml`（`risk-check` → `auto-merge`）と、その経路を持たないリポジトリ
   * 向けの保険（`reusable-issue-labels.yml`の`develop-pr-opened`。#1470）で、どちらも結論を
   * **PRではなく対応Issueの`00.check-user`**として書く。PR画面はこれを合流させて
   * 「ユーザーのマージが必要です」を出す（#1469。判定は`requiresUserMerge`）。
   */
  linkedIssueCheckUser: boolean;
  /**
   * 対応Issueの`00.check-user`が付いている理由（`01.check-*`。#1490）。理由ラベルが
   * 配られていないリポジトリ・`00.check-user`が付いていない場合は`null`で、そのときは
   * `linkedIssueCheckUser`だけを見る従来の判定へフォールバックする（`requiresUserMerge`）。
   */
  linkedIssueCheckReason: CheckUserReason | null;
  /** headコミットのcheck-runsを集約したCI状態。closedなPRでは取得せず`unknown` */
  ciState: CiState;
  /**
   * CIの内訳（ジョブ単位の進み具合・所要時間）を開くためのrun id（#2777）。読めなければnull。
   *
   * **CI状態と同じ1回のGraphQLに含まれる`detailsUrl`から取り出しているだけ**なので、
   * これを持ってもGitHub APIの消費は増えない。nullのときは内訳を出さず、従来どおり
   * CI状態のバッジだけを出す。
   */
  ciRunId: number | null;
  /**
   * CIの内訳に並べるチェック一覧（#2777）。CI状態のバッジと**同じ母集団**で、
   * CI状態と同じ1回のGraphQLから作っているためGitHub APIの消費は増えない。
   *
   * **`ciRunId`の実行のジョブで代用しない。** mainへのリリースPRでは`ci.yml`のほかに
   * `version-tag-check.yml`のジョブもCI状態に入るため、run 1本ぶんだけを並べると
   * 「バッジは失敗・内訳は全部成功」という食い違いを作れる。
   */
  ciChecks: PullRequestCiCheck[];
  /**
   * 自動マージ可否の判定（`claude-review-develop.yml`）の進み具合（#1968）。
   *
   * **CI状態（`ciState`）とは別の軸。** 判定のcheck-runは#1799でCI状態の集約から外して
   * あるため、判定が走っている最中でも`ciState`は`success`になる。`pending`のあいだは
   * 「developへマージしてよいか」がまだ決まっていないので、画面のマージボタンを押せなく
   * する（`isMergeJudgementPending`）。CI状態と同じ1回のGraphQLで取れるため、
   * これを持つことでGitHub APIの消費は増えない。
   */
  mergeJudgement: MergeJudgement;
  /**
   * baseブランチとのコンフリクトの有無（#1742）。`false`＝コンフリクトあり・`true`＝マージ可能・
   * `null`＝GitHubが判定中（非同期に計算される）か、そもそも取得していない（draft・closed）。
   *
   * **`null`を「コンフリクトなし」として扱わない。** 判定が出るまではコンフリクトの表示も
   * 自動解消ボタンも出さないという意味で、`repairKindsFor`もその方針で書かれている。
   * CI状態と同じ1回のGraphQLで取るため、これを持つことでGitHub APIの消費は増えない。
   */
  mergeable: boolean | null;
  /**
   * 自動修復ワークフローが対象リポジトリに置かれているか（#1960）。修復ボタンを出す種類
   * （`repairKindsFor`の結果）ごとに持つ。
   *
   * **判定するのはボタンを出すPRだけ**なので、ボタンが出ないPR（CIが通っている・closed・draft）
   * では`{}`になる。`{}`のキーが無い種類は「押せる」扱い（`isRepairWorkflowMissing`）。
   * これが`false`の種類は押しても`workflow_dispatch`が404になるため、画面側で無効化する。
   */
  repairWorkflowAvailability: RepairWorkflowAvailability;
  /**
   * このPRの自動修復がいま走っているか（#2072）。走っていなければnull。
   *
   * **CI状態（`ciState`）・コンフリクト（`mergeable`）とは別の軸。** CIが失敗したまま
   * 修復が走っている時間帯があり、そこを「チェック失敗」だけで見せると、放っておけば
   * 片付くのか自分で直すのかが判断できない（それがこのIssueの起点）。
   *
   * 材料はGitHubではなくissue-deckのDB（`PullRequestRepairRun`）で、走っている
   * ワークフロー自身が報告する。**GitHub APIからは引けない**理由は
   * [`lib/github/pull-request-repair-run.ts`](../lib/github/pull-request-repair-run.ts)を参照。
   */
  repairRun: PullRequestRepairRunSummary | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * PR1件が本番へ届いたか（#1814）。`GET /api/pull-requests/deploy-status`が返す。
 *
 * - `develop-only` … developへは入ったが、まだmainへ運ばれていない（本番未反映）
 * - `waiting` … mainへ入ったが、そのデプロイ実行がまだ現れていない
 * - `running` … `deploy.yml`が実行中
 * - `deployed` … デプロイが成功した（＝ここで初めて「本番反映」と言ってよい）
 * - `failed` … デプロイが失敗した（**mainには入ったが本番には出ていない**）
 *
 * 判定できない場合（未マージ・`deploy.yml`が無い・取得した範囲より古いPR）は状態そのものが
 * `null`になり、画面は何も出さない。**間違った状態を出すより「何も言わない」方がよい**
 * （ブランチ画面の`BranchFlowDeployState`と同じ方針。#1579）。
 */
export type PullRequestDeployStatusKind =
  | "develop-only"
  | "waiting"
  | "running"
  | "deployed"
  | "failed";

export type PullRequestDeployStatus = {
  kind: PullRequestDeployStatusKind;
  /** 本番へ運んだ（運ぼうとしている）リリースの版。タイトルから取れなければnull */
  version: string | null;
  /** 運んだリリースPRの番号。特定できなければnull */
  releasePullRequestNumber: number | null;
  /** デプロイ実行のログURL。実行がまだ無い（`waiting`・`develop-only`）場合はnull */
  deployRunUrl: string | null;
};

export type PullRequestDeployStatusResponse = {
  /** 判定できなければnull */
  status: PullRequestDeployStatus | null;
  /**
   * そのリポジトリで開いているデプロイ失敗Issue（#2236）。無ければnull。
   * **`status.kind`が`failed`のときにしか使わない**が、判定はリポジトリ単位なので
   * `status`とは別に持つ。
   */
  failureIssue: DeployFailureIssueRef | null;
  /** 取得時刻（ISO8601） */
  fetchedAt: string;
};

/**
 * Issue画面の「対応PR」1件ぶんの情報（#1339）。
 *
 * 1つのIssueに複数のPRがぶら下がりうるため、Issue画面はこれを配列で持つ。
 * `PullRequestSummary`（PR一覧・PR詳細向け）は作者・base/head・Auto-merge等まで持つが、
 * Issue画面が要るのは「どのPRか・マージできるか」だけなので別の型にしている。
 * CI状態も`PullRequestSummary`の`CiState`ではなく、マージボタンと同じ
 * `PullRequestCiStatus`（`lib/github/pull-request-ci.ts`）に揃える。
 */
export type IssuePullRequest = {
  number: number;
  htmlUrl: string;
  title: string;
  /** open（マージ待ち）かclosed（マージ済み・却下）か */
  state: "open" | "closed";
  draft: boolean;
  /** マージ済みか。`state`がclosedのときだけtrueになりうる */
  merged: boolean;
  /**
   * headコミットのCI状態。openかつdraftでないPRでのみ取得し、それ以外はnull
   * （closedやdraftでCIを見ても判断に使わないため、1リクエストを使わない）
   */
  ciStatus: PullRequestCiStatus | null;
  /**
   * 自動マージ可否の判定の進み具合（#1968）。`ciStatus`と同じくopenかつdraftでないPRでのみ
   * 取得し、それ以外は`unknown`。`pending`のあいだはIssue画面のマージボタンを押せなくする。
   */
  mergeJudgement: MergeJudgement;
  /**
   * baseブランチとのコンフリクトの有無（#2145）。意味は`PullRequestSummary.mergeable`と同じで、
   * `false`＝コンフリクトあり・`true`＝マージ可能・`null`＝GitHubが判定中か未取得（draft・closed）。
   *
   * **`null`を「コンフリクトなし」として扱わない。** CI状態と同じ1回のGraphQLから取れるため、
   * これを持つことでGitHub APIの消費は増えない。
   */
  mergeable: boolean | null;
  /**
   * このPRの自動修復がいま走っているか（#2145）。走っていなければnull。意味は
   * `PullRequestSummary.repairRun`と同じで、材料もGitHubではなくissue-deckのDB
   * （`PullRequestRepairRun`）。
   *
   * **CI状態・コンフリクトとは別の軸。** コンフリクトしたまま自動解消が走っている時間帯を
   * 「コンフリクトあり」だけで見せると、放っておけば片付くのか自分で直すのかが判断できない。
   */
  repairRun: PullRequestRepairRunSummary | null;
  /** headブランチ名・タイトル・本文から推定した対応Issue番号。特定できなければnull */
  linkedIssueNumber: number | null;
};

export type IssuePullRequestListResponse = {
  pullRequests: IssuePullRequest[];
};

/**
 * 一覧APIが取りに行く母集団（#1312）。
 *
 * `open`はマージ待ちのPRだけ、`all`はそこへクローズ済み（マージ済み・却下）を直近ぶんだけ足す。
 * クライアント側のビュー（処理中・完了）はどちらも`open`の結果を絞るだけなので、
 * ビューを切り替えてもGitHub APIを叩き直さない。
 */
export type PullRequestListScope = "open" | "all";

/**
 * 左メニューの「Pull Request」セクションで選べる状態別ビュー（#1312）。
 *
 * - `all` … openなPRの全件
 * - `in-progress` … CIの結果待ち（ドラフト・CI状態不明を含む）と、CI通過後に自動マージ可否の
 *   判定が動いているPR（Claudeのレビュー中など。#2283）。待つしかないPR
 * - `completed` … CIも判定も終わったopenなPR（マージできる）と、CIが失敗しているPR
 *   （判定中でもここに残す。#2283）。手を動かすべきPR。
 *   画面上の表示名は「マージ待ち」（#2120）。idを変えると`prview=completed`のURLが切れるため、
 *   ここは`completed`のままにしてある
 *
 * `in-progress`と`completed`でopenなPRを過不足なく二分する。
 */
export type PullRequestViewId = "all" | "in-progress" | "completed";

export type PullRequestListResponse = {
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
  /**
   * 取得時刻（ISO8601）。ヘッダーに出す`summary`を一覧の項目と詳細のどちらから採るかの
   * 判定に使う（新しい方を採る。#1578）。一覧の`fetchedAt`と同じくサーバー側の時刻。
   */
  fetchedAt: string;
  /** PRの本文。未記入なら空文字 */
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  /** 時系列（古い順）に並べたコメント・レビュー */
  events: PullRequestEvent[];
};

/**
 * 変更ファイルの種別（#1987）。GitHubの`status`（`added`・`modified`ほか）を、画面に出す
 * 4種類へ寄せたもの。`copied`・`changed`のように滅多に出ない値まで別扱いにしても
 * 読む側の判断は変わらないため、`modified`（変更）へ寄せる。
 */
export type PullRequestFileChange = "added" | "modified" | "removed" | "renamed";

/** PRで変更されたファイル1件（#1987） */
export type PullRequestFile = {
  /** 変更後のパス。削除されたファイルは削除前のパス */
  path: string;
  change: PullRequestFileChange;
  additions: number;
  deletions: number;
  /** GitHubでそのファイルを開くURL */
  blobUrl: string;
  /** `renamed`のときのみ、変更前のパス。それ以外はnull */
  previousPath: string | null;
};

/**
 * マージ確認ダイアログに並べる「このマージに含まれる変更」1件（#2080）。
 *
 * - `issue` … developへ入った作業PR（`issue-<番号>`ブランチ）
 * - `version-bump` … バージョンバンプPR（`release/vX.Y.Z`）。利用者から見た変更ではない
 * - `commit` … マージコミットへ畳めなかったコミット（squash運用のリポジトリ）
 */
export type PullRequestChangeKind = "issue" | "version-bump" | "commit";

export type PullRequestChange = {
  /** 一覧のkeyに使う識別子（コミットのSHA） */
  id: string;
  /** developへ入ったPRの番号。マージコミットから取れなければnull */
  pullRequestNumber: number | null;
  /** そのPRの対応Issue番号（ブランチ名`issue-<番号>`から）。取れなければnull */
  issueNumber: number | null;
  /** 画面に出す見出し。対応Issueのタイトル→PRのタイトル→コミットの件名の順で決まる */
  title: string;
  kind: PullRequestChangeKind;
};

export type PullRequestChangeListResponse = {
  /** 新しい順 */
  changes: PullRequestChange[];
  /** 取得できたコミット数（打ち切っている場合は上限値） */
  commitCount: number;
  /**
   * 1ページの上限で打ち切ったか（#2080）。trueのときは画面に「一部である」旨を出し、
   * 残りはGitHubで見てもらう（`PullRequestFileListResponse.truncated`と同じ方針）。
   */
  truncated: boolean;
};

export type PullRequestFileListResponse = {
  files: PullRequestFile[];
  /**
   * 1ページの上限で打ち切ったか（#1987）。trueのときは画面に「先頭100件」である旨を出し、
   * 残りはGitHubで見てもらう。
   */
  truncated: boolean;
};
