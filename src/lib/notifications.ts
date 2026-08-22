import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import { isMergeAwaitingCi } from "@/lib/check-user-notification";
import {
  CHECK_USER_LABEL,
  CHECK_USER_REASON_TEXT,
  checkUserReason,
} from "@/lib/github/approval-labels";
import {
  describeReleaseStatusBadge,
  releaseAttentionRank,
} from "@/lib/github/release-button-status";
import { REPAIR_KIND_RUNNING_SHORT_LABEL } from "@/lib/github/pull-request-repair";
import { buildPullRequestId } from "@/lib/github-reference";
import { computeManualStepReadiness } from "@/lib/manual-step-attention";
import { filterPullRequestsByView } from "@/lib/pull-request-list";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * ヘッダーの通知ベル（#1614）が集める「ユーザーの操作が必要なもの」。
 *
 * 元はリリース専用のロケットボタン（`release-status-button.tsx`）が置かれていた場所で、
 * リリースの起動・マージ・進捗・バージョン確認は「ブランチ」画面（`branch-flow-view.tsx`）が
 * ほぼ同じものを持っている。ロケットにしか無かったのは**リポジトリ横断で「いま人が動かないと
 * 止まるものがどこにあるか」が分かる**ことなので、そこだけをリリース以外へも広げて残した。
 *
 * **判定は既存の純粋関数へ委ねる。** リリースは`describeReleaseStatusBadge`、確認待ちは
 * `checkUserReason`、PRは`filterPullRequestsByView`（左メニューの「マージ待ち」と同じ母集団）、
 * 手作業は`computeManualStepReadiness`（左メニューの「ユーザーの作業待ち」と同じ判定）。
 * ここで新しい基準を作ると、同じ状態を指す文言や件数が画面ごとに食い違う。
 *
 * **追加のGitHub API消費はゼロ。** 入力の4つはいずれも`IssueDeckShell`とベル自身が
 * 既に取得済みのものをそのまま渡している。
 */

/** 見た目の強さ。`error`が1件でもあればバッジの色が変わる */
export type NotificationTone = "error" | "action" | "info";

/** ポップオーバー内での区分。表示順もこの並び */
export type NotificationGroup = "release" | "check-user" | "pull-request" | "manual-step";

/** 行を押したときの遷移先 */
export type NotificationTarget =
  | { kind: "issue"; issueId: string }
  | { kind: "pull-request"; pullRequestId: string }
  | { kind: "flow" };

export type NotificationItem = {
  /** Reactのkey。同じ対象が2行に出ないよう対象を含めて組み立てる */
  id: string;
  group: NotificationGroup;
  tone: NotificationTone;
  /** 1行目。何をすればよいかが読み取れる文言にする */
  title: string;
  /** 種別バッジの文言（「mainへマージ待ち」「計画の承認」など） */
  badgeLabel: string;
  repositoryFullName: string;
  /**
   * 待たせている時間の基準（ISO8601）。相対時刻の表示と並び替えに使う。
   * リリースは情報源（`/api/repositories/release-pending-merges`）が時刻を持たないためnull。
   */
  since: string | null;
  target: NotificationTarget;
};

export const NOTIFICATION_GROUP_LABEL: Record<NotificationGroup, string> = {
  release: "リリース",
  "check-user": "確認待ち",
  "pull-request": "Pull Request",
  "manual-step": "手作業待ち",
};

/** 区分の表示順。重い（放置すると全体が止まる）ものから並べる */
export const NOTIFICATION_GROUP_ORDER: readonly NotificationGroup[] = [
  "release",
  "check-user",
  "pull-request",
  "manual-step",
];

const TONE_RANK: Record<NotificationTone, number> = { error: 0, action: 1, info: 2 };

export type BuildNotificationsInput = {
  /** 絞り込み前の全Issue（ベルはTopBarの絞り込みに追随しない。横断で見る場所のため） */
  issues: Issue[];
  /** 画面が取得済みのopenなPR一覧 */
  pullRequests: PullRequestSummary[];
  /** リポジトリごとのリリース状況。未取得はnull */
  releaseStatuses: RepositoryReleaseStatus[] | null;
  /**
   * 確認待ちのうち、まだエージェントが動いていて押せる操作が無いIssueのid（#2174）。
   * **画面が左メニューの件数に使っているのと同じ集合を渡す**——ここで数え直すと、
   * メニューからは消えているのにベルには「PRのマージ」と出ている状態になる。
   */
  checkUserRunningIssueIds?: ReadonlySet<string>;
};

/**
 * リリースの通知を組み立てる。
 *
 * `idle`（静止）はAPIがそもそも返さないが、`progressing`（自動で進行中）も**出さない**。
 * 人が何もしなくてよいものを並べるとベルを開く意味が薄れるため、残るのは
 * `action_required`（マージ待ち）と`error`／CI失敗だけになる。文言とトーンは
 * モバイルのリポジトリ一覧・ブランチ画面と同じ`describeReleaseStatusBadge`から得る。
 */
function buildReleaseNotifications(
  releaseStatuses: RepositoryReleaseStatus[] | null,
): NotificationItem[] {
  return [...(releaseStatuses ?? [])]
    .sort((a, b) => {
      const rank =
        releaseAttentionRank({ status: a.status, ciState: a.pendingMerge?.ciState ?? null }) -
        releaseAttentionRank({ status: b.status, ciState: b.pendingMerge?.ciState ?? null });
      return rank !== 0 ? rank : a.repoFullName.localeCompare(b.repoFullName);
    })
    .flatMap((releaseStatus) => {
      const badge = describeReleaseStatusBadge({
        status: releaseStatus.status,
        failedWorkflow: releaseStatus.failedWorkflow,
        mergeTarget: releaseStatus.pendingMerge?.mergeTarget ?? null,
        ciState: releaseStatus.pendingMerge?.ciState ?? null,
      });
      if (badge === null || badge.tone === "progressing") return [];

      const pendingMerge = releaseStatus.pendingMerge;
      const title = pendingMerge
        ? `#${pendingMerge.pullRequestNumber} ${pendingMerge.pullRequestTitle}`
        : releaseStatus.failedWorkflow === "deploy"
          ? "本番デプロイの実行が失敗しました"
          : "リリースの実行が失敗しました";

      return [
        {
          id: `release:${releaseStatus.repoFullName}:${pendingMerge?.pullRequestNumber ?? "run"}`,
          group: "release",
          tone: badge.tone === "error" ? "error" : "action",
          title,
          badgeLabel: badge.label,
          repositoryFullName: releaseStatus.repoFullName,
          since: null,
          // マージ待ちはPR詳細（マージボタンとCI状態がある）へ、PRを伴わない実行の失敗は
          // ブランチ画面へ送る。ブランチ画面はリポジトリ単位のアンカーを持たないため、
          // 対象が特定できているときはPR詳細の方が短い。
          target: pendingMerge
            ? {
                kind: "pull-request",
                pullRequestId: buildPullRequestId(
                  releaseStatus.repoFullName,
                  pendingMerge.pullRequestNumber,
                ),
              }
            : { kind: "flow" },
        } satisfies NotificationItem,
      ];
    });
}

/**
 * 確認待ち（`00.check-user`）のIssue。PR側の重複除去（同じ操作を2行に出さない）でも
 * 同じ集合が要るため、通知の組み立てとは別に切り出してある。
 */
function selectCheckUserIssues(issues: Issue[]): Issue[] {
  return issues.filter(
    (issue) =>
      issue.state === "open" && issue.labels.some((label) => label.name === CHECK_USER_LABEL),
  );
}

/**
 * 確認待ちの通知。理由ラベル（`01.check-*`）が読めればその文言を出す。
 * 並びは呼び出し側で「待たせている時間が長い順」（＝左メニューの「確認待ち」ビューと同じ考え方）。
 *
 * **マージを求めているのに対応PRのチェックがまだ確定していないものは「CI実行中」として弱める**
 * （#1709）。ラベルを付ける側がCIの完了を待たないことがあり、そのまま「PRのマージ」と出すと
 * 押しても弾かれる操作を要求することになる。判定は`isMergeAwaitingCi`（`ciState`を読むだけ）。
 */
function buildCheckUserNotifications(
  issues: Issue[],
  pullRequests: PullRequestSummary[],
  runningIssueIds: ReadonlySet<string> | undefined,
): NotificationItem[] {
  return selectCheckUserIssues(issues).map((issue) => {
    const reason = checkUserReason(issue.labels);
    const awaitingCi = isMergeAwaitingCi(issue, pullRequests);
    // エージェントがまだ動いているもの（#2174）。左メニューの件数から外したのと同じ集合で、
    // CIの完了待ち（#1709）と同じく「いま人が動けるものではない」側へ寄せる
    const running = runningIssueIds?.has(issue.id) === true;
    return {
      id: `check-user:${issue.id}`,
      group: "check-user",
      // 「回答の確認」は読むだけで手は止まっていないので弱める（#1490の表の`answered`）。
      // CIの完了待ち・エージェントの実行中も、いま人が動けるものではないので同じ扱いにする。
      tone: reason === "answered" || awaitingCi || running ? "info" : "action",
      title: `#${issue.number} ${issue.title}`,
      badgeLabel: awaitingCi
        ? "CI実行中"
        : running
          ? "実行中"
          : reason
            ? CHECK_USER_REASON_TEXT[reason]
            : "確認待ち",
      repositoryFullName: issue.repositoryFullName,
      since: issue.checkUserLabeledAt ?? issue.updatedAt,
      target: { kind: "issue", issueId: issue.id },
    } satisfies NotificationItem;
  });
}

/**
 * 手作業待ち（`71.manual-step`）の通知。openのまま残り続けるので、古いものほど上に出る。
 *
 * **並べるのは前提条件が満たされていて、いま実行できるものだけ**（#1801）。手作業Issueの多くは
 * 先行する変更が本番へ出た後でなければ実行できず（`manual-step-attention.ts`）、数週間先まで
 * 動かせないものまで並べるとベルが「いま人が動けば盤面が進むもの」を集める場所として読めなくなる
 * （リリースの`progressing`を出さないのと同じ理由）。数え方は左メニューの「ユーザーの作業待ち」
 * （`actionable`だけを数える。#1763）と揃えてある。**ただしベルの件数バッジには数えない**
 * （#1936。`BADGE_EXCLUDED_GROUPS`）。
 *
 * 判定は左メニュー・一覧の行アイコンと同じ`computeManualStepReadiness`へ委ねる。母集団は
 * ベルが受け取る全Issue（TopBarの絞り込み前）なので、参照先の解決もそのまま行える。
 * 状態を取れない参照は「実行できる」側に数えるため、そうした手作業はベルに残る。
 */
function buildManualStepNotifications(issues: Issue[]): NotificationItem[] {
  const readiness = computeManualStepReadiness(issues);
  return issues
    .filter((issue) => readiness.get(issue.id)?.ready === true)
    .map(
      (issue) =>
        ({
          id: `manual-step:${issue.id}`,
          group: "manual-step",
          tone: "info",
          title: `#${issue.number} ${issue.title}`,
          badgeLabel: "手作業",
          repositoryFullName: issue.repositoryFullName,
          since: issue.createdAt,
          target: { kind: "issue", issueId: issue.id },
        }) satisfies NotificationItem,
    );
}

/**
 * マージ待ちPRの通知。母集団は左メニューの「マージ待ち」と同じ（open・非draft・CIが確定）で、
 * そこから**放っておけば入るもの**（Auto-merge有効でCI成功）だけを除く。
 *
 * `excludedIds`は他の区分で既に出しているPR。同じ操作が2行に出ると件数が実態より多く見える。
 */
function buildPullRequestNotifications(
  pullRequests: PullRequestSummary[],
  excludedIds: Set<string>,
): NotificationItem[] {
  return filterPullRequestsByView(pullRequests, "completed")
    .filter((pullRequest) => !excludedIds.has(pullRequest.id))
    .filter((pullRequest) => !(pullRequest.autoMergeEnabled && pullRequest.ciState === "success"))
    .map((pullRequest) => {
      // 自動修復が走っているあいだは赤（`error`）を出さない（#2072）。CIは失敗したままだが、
      // いま人が動けるものではないため、確認待ちの「CI実行中」と同じく`info`まで弱める。
      // 直せなかった場合は対応Issueに`00.check-user`が付き、確認待ちとして改めて通知される。
      const repairRun = pullRequest.repairRun;
      const failed = pullRequest.ciState === "failure" && repairRun === null;
      return {
        id: `pull-request:${pullRequest.id}`,
        group: "pull-request",
        tone: repairRun ? "info" : failed ? "error" : "action",
        title: `#${pullRequest.number} ${pullRequest.title}`,
        badgeLabel: repairRun
          ? REPAIR_KIND_RUNNING_SHORT_LABEL[repairRun.kind]
          : failed
            ? "チェック失敗"
            : `${pullRequest.baseRef}へマージ待ち`,
        repositoryFullName: pullRequest.repositoryFullName,
        since: pullRequest.createdAt,
        target: { kind: "pull-request", pullRequestId: pullRequest.id },
      } satisfies NotificationItem;
    });
}

/**
 * 通知を組み立てて表示順に並べる。
 *
 * 並びは区分の固定順（`NOTIFICATION_GROUP_ORDER`）→ トーンの強い順 → 待たせている時間が
 * 長い順。時刻を持たないリリースは`buildReleaseNotifications`側の並び（要対応度→リポジトリ名）を
 * `sort`の安定性で保つ。
 */
export function buildNotifications(input: BuildNotificationsInput): NotificationItem[] {
  const { issues, pullRequests, releaseStatuses, checkUserRunningIssueIds } = input;

  const releaseItems = buildReleaseNotifications(releaseStatuses);
  const checkUserItems = buildCheckUserNotifications(
    issues,
    pullRequests,
    checkUserRunningIssueIds,
  );
  const manualStepItems = buildManualStepNotifications(issues);

  // PR側から落とす対象を集める。
  // 1. リリースのマージ待ちとして既に出したPR。
  // 2. 確認待ちとして既に出したIssueに紐づくPR。Issue詳細に`issue-merge-button.tsx`が
  //    あるので操作は失われず、左メニューの「確認待ち」件数とも食い違わない。
  const excludedPullRequestIds = new Set<string>(
    releaseItems.flatMap((item) =>
      item.target.kind === "pull-request" ? [item.target.pullRequestId] : [],
    ),
  );
  const checkUserIssueKeys = new Set(
    selectCheckUserIssues(issues).map((issue) => `${issue.repositoryFullName}#${issue.number}`),
  );
  pullRequests.forEach((pullRequest) => {
    if (pullRequest.linkedIssueNumber === null) return;
    const key = `${pullRequest.repositoryFullName}#${pullRequest.linkedIssueNumber}`;
    if (checkUserIssueKeys.has(key)) excludedPullRequestIds.add(pullRequest.id);
  });

  const items = [
    ...releaseItems,
    ...checkUserItems,
    ...buildPullRequestNotifications(pullRequests, excludedPullRequestIds),
    ...manualStepItems,
  ];

  return items.sort((a, b) => {
    const byGroup =
      NOTIFICATION_GROUP_ORDER.indexOf(a.group) - NOTIFICATION_GROUP_ORDER.indexOf(b.group);
    if (byGroup !== 0) return byGroup;
    const byTone = TONE_RANK[a.tone] - TONE_RANK[b.tone];
    if (byTone !== 0) return byTone;
    if (a.since === null || b.since === null) return 0;
    return new Date(a.since).getTime() - new Date(b.since).getTime();
  });
}

/**
 * バッジに出す件数の対象外にする区分（#1936）。
 *
 * **手作業待ち（`71.manual-step`）はバッジに数えない。** ベルのバッジは「いま人が動けば盤面が
 * 進むものがいくつあるか」を閉じたまま見るためのもので、増えたら開く・0になったら見なくてよい、
 * という読み方で使う。手作業Issueは実行できる状態になってからも人の都合で数日〜数週間openのまま
 * 残るため、数えると常時点灯し、確認待ち・マージ待ちPRが1件増えたことに気づけなくなる。
 *
 * **一覧（`groupNotifications`）からは外さない。** リポジトリ横断で手作業待ちを見られる場所は
 * ベルの中しかなく（スマホは特に）、そこから消すと今度は存在自体に気づけない。
 * バッジと一覧で母集団が違うことは、開いたときの見出しの内訳（`describeNotificationCount`）で
 * 説明する。
 */
const BADGE_EXCLUDED_GROUPS: readonly NotificationGroup[] = ["manual-step"];

/** バッジに出す件数。手作業待ち（`BADGE_EXCLUDED_GROUPS`）を除いた件数を返す（#1936） */
export function countBadgeNotifications(items: NotificationItem[]): number {
  return items.filter((item) => !BADGE_EXCLUDED_GROUPS.includes(item.group)).length;
}

/**
 * ベルを開いたときの見出しに出す件数の文言（#1936）。
 *
 * バッジの件数（手作業待ちを除く）を先に置き、除いたぶんがあるときだけ内訳を添える。
 * 左メニューの「ユーザーの作業待ち」（`formatManualStepListCount`の`2件・前提待ち2件`）と
 * 同じ書き方で、**バッジの数字と一覧の行数が食い違う理由を画面の中だけで読めるようにする。**
 */
export function describeNotificationCount(items: NotificationItem[]): string {
  const badgeCount = countBadgeNotifications(items);
  const excluded = items.length - badgeCount;
  return excluded === 0 ? `${badgeCount}件` : `${badgeCount}件・手作業待ち${excluded}件`;
}

/** バッジの色。1件でも失敗が混ざれば赤にする（開かずに「直す必要がある」と気づけるのはここだけ） */
export function hasErrorNotification(items: NotificationItem[]): boolean {
  return items.some((item) => item.tone === "error");
}

/** 区分ごとに分けて表示順に返す。空の区分は含めない */
export function groupNotifications(
  items: NotificationItem[],
): { group: NotificationGroup; items: NotificationItem[] }[] {
  return NOTIFICATION_GROUP_ORDER.map((group) => ({
    group,
    items: items.filter((item) => item.group === group),
  })).filter((entry) => entry.items.length > 0);
}
