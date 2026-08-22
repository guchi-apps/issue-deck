import { db } from "@/lib/db";
import {
  CHECK_USER_REASON_TEXT,
  checkUserReason,
  type CheckUserReason,
} from "@/lib/github/approval-labels";
import {
  isPushConfigured,
  sendPushNotification,
  type PushNotificationPayload,
} from "@/lib/notifications/push";

/**
 * 確認待ち（`00.check-user`）になったIssueのPush通知（#838）。
 *
 * **ラベルが付いた瞬間には送らない。** 少し待ってから、そのとき残っているラベルを読んで送る。
 * 理由は2つあり、どちらも「鳴ってからでは取り消せない」ことに由来する。
 *
 * - **早すぎる`00.check-user`が実際にある**（#1709）。実装エージェントはPR作成の直後に
 *   自分で`00.check-user`＋`01.check-merge`を付けるが、その時点ではCIが走っていてマージ
 *   できない。#1709の例では10分後に自動マージされ、ラベルごと消えた——通知そのものが
 *   不要だった。画面のトースト（`check-user-notification.ts`）は出す前に保留できるが、
 *   OSの通知はそうはいかない。そこで`01.check-merge`だけ待ち時間を長く取り、
 *   **自動で消えるものは鳴る前に消えている**状態にする
 * - **理由ラベル（`01.check-*`）は`00.check-user`より後に付く**。ローカルセッションの経路は
 *   `00.check-user`を単独で先に付け、理由は続く別のリクエストで付ける
 *   （`dispatch/check-user-labels.ts`）。付いた瞬間に読むと理由が引けず、
 *   「確認待ちになりました」としか言えない
 *
 * 送信済みかどうかは`Issue.checkUserPushSentAt`で持つ。`00.check-user`が付き直すたびに
 * `checkUserLabeledAt`とセットでnullへ戻る（`github/sync-issues.ts`）ので、
 * 「まだnullで、付与から待ち時間が過ぎたもの」が未送信の集合になる。
 */

/** 既定の待ち時間。理由ラベルが揃うのを待つだけなので短くてよい */
export const CHECK_USER_PUSH_DELAY_MS = 3 * 60 * 1000;

/**
 * `01.check-merge`だけの待ち時間。
 *
 * トーストの保留の上限（`CHECK_USER_TOAST_MAX_HOLD_MS` = 10分）より長く取る。CIの完了と
 * それに続く自動マージがこの中で終われば、ラベルは消えて通知は送られない。**それでも
 * 残っているなら、人がマージするしかないもの**（自動マージ不可カテゴリ）なので通知する。
 */
export const CHECK_USER_MERGE_PUSH_DELAY_MS = 15 * 60 * 1000;

/**
 * これより古い確認待ちは、未送信でも通知しない（記録だけ付けて終わる）。
 *
 * 機能を入れた直後や、購読を後から登録したときに、**溜まっていた確認待ちが一斉に鳴る**のを
 * 防ぐ。半日以上前から待っているものは、開けばベルにも一覧にも出ている。
 */
export const CHECK_USER_PUSH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 1回の巡回で見る件数の上限。取りこぼしても次の巡回で拾える */
const SWEEP_BATCH_SIZE = 50;

/** 理由ごとの待ち時間 */
export function checkUserPushDelayMs(reason: CheckUserReason | null): number {
  return reason === "merge" ? CHECK_USER_MERGE_PUSH_DELAY_MS : CHECK_USER_PUSH_DELAY_MS;
}

export type CheckUserPushDecision = "send" | "wait" | "skip";

/**
 * いま送ってよいか。`skip`は「送らずに送信済みとして記録する」（古すぎるもの）。
 *
 * 理由ラベルが読めない（配られていない）リポジトリは既定の待ち時間で送る。
 * 判断できないものを黙らせると、通知が来ないことにも気づけないため。
 */
export function decideCheckUserPush(input: {
  labels: readonly { name: string }[];
  checkUserLabeledAt: Date;
  now: Date;
}): CheckUserPushDecision {
  const elapsed = input.now.getTime() - input.checkUserLabeledAt.getTime();
  if (elapsed >= CHECK_USER_PUSH_MAX_AGE_MS) return "skip";
  const reason = checkUserReason(input.labels);
  return elapsed >= checkUserPushDelayMs(reason) ? "send" : "wait";
}

/**
 * 通知の中身。1行目にIssue、2行目にリポジトリと「何を求められているか」を置く。
 * 文言は画面内のトースト（`check-user-toast-viewport.tsx`）と同じ語彙にそろえる。
 */
export function buildCheckUserPushPayload(issue: {
  githubIssueId: bigint;
  number: number;
  title: string;
  repositoryFullName: string;
  labels: readonly { name: string }[];
}): PushNotificationPayload {
  const reason = checkUserReason(issue.labels);
  const repositoryName = issue.repositoryFullName.split("/")[1] ?? issue.repositoryFullName;
  const issueId = String(issue.githubIssueId);
  return {
    title: `#${issue.number} ${issue.title}`,
    body: `${repositoryName} ・ ${reason ? CHECK_USER_REASON_TEXT[reason] : "確認待ち"}`,
    // PC（`issue`）とスマホ（`mscreen`・`missue`）で現在地の持ち方が違うので両方載せる。
    // `useReferenceNavigation.openIssue`が画面内のリンクで組み立てるURLと同じ形
    url: `/dashboard?issue=${issueId}&mscreen=issue-detail&missue=${issueId}`,
    tag: `check-user:${issueId}`,
  };
}

/**
 * 待ち時間の過ぎた確認待ちをまとめて通知する。
 *
 * **常駐プロセスは置かない**（`runManualStepVerificationPatrol`と同じ方針）。呼ぶのは
 * サブPCのpollerが叩く`POST /api/dispatch/claim`（30秒ごと。ブラウザを開いていなくても回る）と
 * GitHubのWebhook受け口の2か所で、どちらも失敗しても本来の処理を止めない。
 *
 * 送った件数を返す（呼び出し側は使わないが、テストと調査のため）。
 */
export async function sweepCheckUserPushNotifications(now: Date = new Date()): Promise<number> {
  if (!isPushConfigured()) return 0;

  const candidates = await db.issue.findMany({
    where: {
      state: "OPEN",
      checkUserPushSentAt: null,
      checkUserLabeledAt: { lte: new Date(now.getTime() - CHECK_USER_PUSH_DELAY_MS) },
    },
    include: {
      labels: { select: { name: true } },
      repository: { select: { fullName: true, installationId: true } },
    },
    orderBy: { checkUserLabeledAt: "asc" },
    take: SWEEP_BATCH_SIZE,
  });

  let sent = 0;
  for (const issue of candidates) {
    if (!issue.checkUserLabeledAt) continue;
    const decision = decideCheckUserPush({
      labels: issue.labels,
      checkUserLabeledAt: issue.checkUserLabeledAt,
      now,
    });
    if (decision === "wait") continue;

    if (decision === "send") {
      // 宛先は「そのリポジトリのインストールに紐づくユーザー」の購読すべて。
      // リポジトリ単位・種別単位のON/OFFは今回の範囲外（購読の有無だけで決める）
      const targets = await db.pushSubscription.findMany({
        where: { user: { userInstallations: { some: { installationId: issue.repository.installationId } } } },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
      const result = await sendPushNotification(
        targets,
        buildCheckUserPushPayload({
          githubIssueId: issue.githubIssueId,
          number: issue.number,
          title: issue.title,
          repositoryFullName: issue.repository.fullName,
          labels: issue.labels,
        }),
      );
      sent += result.sent;
    }

    // 送れなかった場合も記録は付ける。一時的な失敗のために巡回のたび鳴らし直すより、
    // 1件落とす方が軽い（次の確認待ちは同じ経路で届く）
    await db.issue.update({ where: { id: issue.id }, data: { checkUserPushSentAt: now } });
  }

  return sent;
}
