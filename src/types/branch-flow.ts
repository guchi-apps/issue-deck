import type { ProgressStatusKey } from "@/lib/issue-progress";
import type { PullRequestKind, PullRequestSummary } from "@/types/pull-request";

/** `develop`が`main`よりどれだけ進んでいるか */
export type BranchComparison = {
  /** baseに対してheadが進んでいるコミット数 */
  aheadBy: number;
  /** baseに対してheadが遅れているコミット数 */
  behindBy: number;
};

/**
 * リポジトリ1件ぶんのブランチ状況。`GET /api/branch-flow`が返す。
 *
 * **ブランチを列挙するのではなく、知りたいブランチだけを名指しで確認した結果**を持つ
 * （理由は`lib/github/branches-api.ts`）。そのため「確認したもの」と「存在したもの」を
 * 分けて返す。確認していないブランチについては、この応答は何も言っていない。
 */
export type RepositoryBranchStatus = {
  repositoryFullName: string;
  /** 存在を問い合わせたブランチ名 */
  checkedBranches: string[];
  /** そのうち実在したブランチ名 */
  existingBranches: string[];
  /** `main`と`develop`の差分。どちらかのブランチが無いリポジトリではnull */
  developVsMain: BranchComparison | null;
  /**
   * リリース用workflow（`release-develop-to-main.yml`）を持つか（#1538）。
   * 「リリースする」ボタンを出してよいかの前提。取得に失敗した場合はfalse（出さない）。
   */
  hasReleaseWorkflow: boolean;
};

export type BranchFlowResponse = {
  repositories: RepositoryBranchStatus[];
  /** 取得時刻（ISO8601）。画面のヘッダーに「〜時点」として出す */
  fetchedAt: string;
  /** 取得に失敗したリポジトリのfullName。1件の失敗で全体を落とさないため個別に返す */
  failedRepositories: string[];
};

/**
 * 作業レーン1本の状態。「ブランチとPRがどうなっているか」を1語で表す。
 *
 * - `no-pull-request` … ブランチはあるがPRが1件も無い（実装中、またはPRの作り忘れ）
 * - `open` … マージ待ちのPRがある
 * - `merged` … マージ済み
 * - `closed` … PRが未マージのままクローズされた
 *
 * **「マージ済みなのにブランチが残っている」は状態として持たない。** このリポジトリ群は
 * マージ後のブランチ削除を自動化しておらず（`delete_branch_on_merge`が無効）、実際に数百本の
 * `issue-*`が残っているため、全件が該当してしまい情報にならない。ブランチの掃除は別の
 * 仕組みの話として切り離す。
 */
export type BranchFlowLaneStatus = "no-pull-request" | "open" | "merged" | "closed";

/**
 * レーンに残っている手作業Issue（`71.manual-step`。#1510）。
 *
 * **GitHubネイティブのサブIssue関係は使わない。** 親子関係はDBへキャッシュしておらず
 * （`/api/issues/sub-issues`はIssue詳細を開いたときだけ取る）、持たせるにはGitHub Appの
 * `sub_issues`Webhook購読の追加とスキーマ変更が要る。手作業Issueは本文の`## 関連`へ
 * 起点Issueの番号を書く決まりなので、**DBキャッシュにある本文からの推定で足りる**。
 */
export type BranchFlowManualStep = {
  number: number;
  title: string;
  state: "open" | "closed";
};

/** レーンに紐づくIssue。DBキャッシュに無いIssueでも番号だけは出せるようにする */
export type BranchFlowIssueRef = {
  number: number;
  /** DBキャッシュに無い場合はnull（番号だけ表示する） */
  title: string | null;
  /** DBキャッシュに無い場合はnull */
  progress: ProgressStatusKey | null;
  /** DBキャッシュに無い場合はnull */
  state: "open" | "closed" | null;
};

/**
 * マージ済みの作業が本番（main）まで届いているか（#1455）。
 *
 * - `released` … develop→mainのリリースPRに乗ってmainへ入った。`version`はそのリリースの版
 *   （リリースPRのタイトルから取れなかった場合はnull）
 * - `pending` … developには入ったが、まだリリースPRが出ていない（本番未反映）
 * - `unknown` … 取得しているクローズ済みPRの範囲より古く、どのリリースに乗ったか特定できない
 */
export type BranchFlowReleaseState =
  | { kind: "released"; version: string | null; pullRequestNumber: number }
  | { kind: "pending" }
  | { kind: "unknown" };

/**
 * `develop`へ向かう作業1本ぶん（Issue → ブランチ → PR → マージ先）。
 *
 * PRのあるブランチと、**進行中のIssueに対応する実在のブランチ**の和集合で作る。後者を
 * 混ぜることで「ブランチは上がっているがPRがまだ無い」作業が画面に現れる。
 */
export type BranchFlowLane = {
  /** 一覧のkey。ブランチ名（リポジトリ内で一意） */
  key: string;
  branchName: string;
  kind: PullRequestKind;
  /** このブランチをheadとするPR。新しい順（openを先頭に寄せる） */
  pullRequests: PullRequestSummary[];
  issue: BranchFlowIssueRef | null;
  /**
   * このレーンのPRが参照している、`issue`以外のIssue（#1455）。1本のPRで複数のIssueを
   * 扱った場合にここへ入る。**本文の`#番号`は単なる言及も混ざるため「関連」として出す。**
   */
  relatedIssues: BranchFlowIssueRef[];
  status: BranchFlowLaneStatus;
  /**
   * 本番（main）へ届いているか。**マージ済みのレーンでのみ意味を持ち**、
   * まだマージされていないレーンではnull。どのリリースの束へ入れるかもこれで決まる。
   */
  releaseState: BranchFlowReleaseState | null;
  /** このレーンの対応Issueから生まれた手作業Issue（#1510）。無ければ空配列 */
  manualSteps: BranchFlowManualStep[];
  /** 並び順に使う代表日時（PRがあればその更新日時、無ければnull） */
  updatedAt: string | null;
};

/**
 * リリース1回ぶんの束（#1510）。「このバージョンに何が乗ったか」を表す。
 *
 * 画面はこれを横線1本として描き、`lanes`をその下にぶら下げる。束の作り方は
 * `resolveReleaseState`と同じ計算——作業PRがdevelopへ入った後、最初にマージされた
 * リリースPRがその変更を運んだ——なので、**追加のGitHub API取得は要らない**。
 */
export type BranchFlowReleaseGroup = {
  /** 一覧のkey */
  key: string;
  /** 版。リリースPRのタイトルから取れなかった場合はnull */
  version: string | null;
  /** develop→mainのPR。まだリリースPRが無い（これから出す）束ではnull */
  pullRequest: PullRequestSummary | null;
  /** mainへ入った日時（ISO8601）。**nullなら未リリース**（進行中またはこれから） */
  mergedAt: string | null;
  lanes: BranchFlowLane[];
  /** この束に残っている未完了の手作業Issueの件数 */
  openManualStepCount: number;
};

/**
 * 畳んだ1行（サマリー行）に出す集計（#1510）。
 *
 * **「手が要るか」だけを表す。** 進行中の本数のような量の情報と、CI失敗・マージ待ちのような
 * 手を動かす必要がある情報を分けて持ち、後者を既定で開く条件にも使う。
 */
export type BranchFlowRepositorySummary = {
  /** まだどのバージョンにも乗っていないレーンの本数（クローズ済みを除く） */
  activeLaneCount: number;
  /** CIが失敗しているopenなPRがある */
  hasCiFailure: boolean;
  /** ユーザーがマージするしかないopenなPRがある（リリースPRを除く） */
  needsUserMerge: boolean;
  /** openなリリースPRがある（develop→mainのマージ待ち） */
  releaseInProgress: boolean;
};

/** `develop` → `main` のリリースレーン */
export type BranchFlowRelease = {
  /** develop→mainのPR。無ければnull */
  pullRequest: PullRequestSummary | null;
  comparison: BranchComparison | null;
  /**
   * 直近でmainへ出た版（マージ済みのリリースPRのうち最も新しいもののタイトルから取る）。
   * 取得できたPRの範囲に1件も無ければnull。
   */
  latestVersion: string | null;
};

export type BranchFlowRepository = {
  repositoryFullName: string;
  repositoryPrivate: boolean;
  release: BranchFlowRelease;
  /**
   * まだどのバージョンにも乗っていない作業レーン（#1510）。マージ待ち・PR未作成・
   * 未マージのままクローズ。図のいちばん上に置く。
   */
  activeLanes: BranchFlowLane[];
  /** バージョンごとの束。**新しい順**で、先頭が未リリース（進行中またはこれから）の束 */
  releaseGroups: BranchFlowReleaseGroup[];
  /**
   * developへは入ったが、どの版で本番へ出たか特定できなかったレーン。
   * 取得しているクローズ済みPRの範囲より古いもの。図のいちばん下へまとめる。
   */
  unassignedLanes: BranchFlowLane[];
  summary: BranchFlowRepositorySummary;
  /**
   * リリース用workflow（`release-develop-to-main.yml`）を持つか。「リリースする」を
   * 出してよいリポジトリの前提。**ブランチ状況を取得できていない場合はfalse**（#1538）。
   */
  canRelease: boolean;
  /**
   * いま「リリースする」を押してよいか（#1510）。リリース用workflowがあり、
   * openなリリースPRもバンプPRも無く、未リリースの変更が1つ以上ある場合だけtrue。
   */
  canTriggerRelease: boolean;
  /**
   * 実装が進んでいるはずなのにブランチもPRも見つからないIssue。
   * 「関連が付いていない」ことを隠さないために出す。
   */
  orphanIssues: BranchFlowIssueRef[];
  /** ブランチ状況を取得できたか。falseのときはPRだけから組み立てている */
  branchesLoaded: boolean;
};
