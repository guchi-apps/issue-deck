import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import {
  CHECK_USER_LABEL,
  CHECK_USER_REASON_TEXT,
  checkUserReason,
  isManualStepIssue,
} from "@/lib/github/approval-labels";
import {
  describeReleaseStatusBadge,
  releaseAttentionRank,
} from "@/lib/github/release-button-status";
import { buildPullRequestId } from "@/lib/github-reference";
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
 * `checkUserReason`、PRは`filterPullRequestsByView`（左メニューの「完了したPR」と同じ母集団）。
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
 * 確認待ち（`00.check-user`）の通知。理由ラベル（`01.check-*`）が読めればその文言を出す。
 * 待たせている時間が長い順（＝左メニューの「確認待ち」ビューの並びと同じ考え方）に並べる。
 */
function selectCheckUserIssues(issues: Issue[]): Issue[] {
  return issues.filter(
    (issue) =>
      issue.state === "open" && issue.labels.some((label) => label.name === CHECK_USER_LABEL),
  );
}

function buildCheckUserNotifications(issues: Issue[]): NotificationItem[] {
  return selectCheckUserIssues(issues).map((issue) => {
      const reason = checkUserReason(issue.labels);
      return {
        id: `check-user:${issue.id}`,
        group: "check-user",
        // 「回答の確認」は読むだけで手は止まっていないので弱める（#1490の表の`answered`）。
        tone: reason === "answered" ? "info" : "action",
        title: `#${issue.number} ${issue.title}`,
        badgeLabel: reason ? CHECK_USER_REASON_TEXT[reason] : "確認待ち",
        repositoryFullName: issue.repositoryFullName,
        since: issue.checkUserLabeledAt ?? issue.updatedAt,
        target: { kind: "issue", issueId: issue.id },
      } satisfies NotificationItem;
  });
}

/** 手作業待ち（`71.manual-step`）の通知。openのまま残り続けるので、古いものほど上に出る */
function buildManualStepNotifications(issues: Issue[]): NotificationItem[] {
  return issues
    .filter((issue) => issue.state === "open" && isManualStepIssue(issue.labels))
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
 * マージ待ちPRの通知。母集団は左メニューの「完了したPR」と同じ（open・非draft・CIが確定）で、
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
      const failed = pullRequest.ciState === "failure";
      return {
        id: `pull-request:${pullRequest.id}`,
        group: "pull-request",
        tone: failed ? "error" : "action",
        title: `#${pullRequest.number} ${pullRequest.title}`,
        badgeLabel: failed ? "チェック失敗" : `${pullRequest.baseRef}へマージ待ち`,
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
  const { issues, pullRequests, releaseStatuses } = input;

  const releaseItems = buildReleaseNotifications(releaseStatuses);
  const checkUserItems = buildCheckUserNotifications(issues);
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
