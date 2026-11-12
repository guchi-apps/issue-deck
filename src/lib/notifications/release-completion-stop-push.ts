import { db } from "@/lib/db";
import { buildPullRequestId } from "@/lib/github-reference";
import { notMutedWhere } from "@/lib/notifications/push-kinds";
import { isPushConfigured, sendPushNotification, type PushNotificationPayload } from "@/lib/notifications/push";

/**
 * リリース完了系列（自動公開を含む）が止まって人へ渡したときのPush通知（#5325）。
 *
 * 以前は最新の修正Issueへ`00.check-user`＋`01.check-blocked`を付け、確認待ちのPush（`check-user-push.ts`）に
 * 鳴らしてもらっていた。確認する操作はリリース候補の画面にあるのに札は修正Issueに付くため、「ユーザーの確認待ち」に
 * 修正Issueが並んでいた。札を付けずに鳴らすため、止めた時点でここから直接送る。
 *
 * 種類は「本番マージ待ち」（`release-merge`）に含める。どちらも「リリース候補が人の番で止まっている」知らせで、
 * タップ先も同じ候補PRの詳細になる。送ったら`ReleaseMergePushNotice`の席も取り、同じ候補が巡回
 * （`release-merge-push.ts`。自動公開の停止は工程上も人の番になる）で続けて鳴り直さないようにする。
 *
 * 呼ぶのは系列を`needs_attention`へ移せた1回だけ（`handOff`）なので、ここでは重複を見ない。例外は投げない。
 */
export type ReleaseCompletionStopPush = {
  repositoryFullName: string;
  pullRequestNumber: number;
  /** 自動公開（公開承認から始めた系列）か */
  publish: boolean;
  /** 止めた理由の1行（`releaseCompletionStopMessage`） */
  reason: string | null;
};

export function buildReleaseCompletionStopPushPayload(stop: ReleaseCompletionStopPush): PushNotificationPayload {
  const repositoryName = stop.repositoryFullName.split("/")[1] ?? stop.repositoryFullName;
  const pullRequestId = buildPullRequestId(stop.repositoryFullName, stop.pullRequestNumber);
  const reason = stop.reason?.split("\n")[0]?.trim() || "リリース候補の画面で理由を確認してください";
  return {
    title: `${repositoryName} ・ ${stop.publish ? "自動公開が停止" : "リリース完了系列が停止"}`,
    body: `#${stop.pullRequestNumber} ${reason}`,
    // 本番マージ待ちのPush（`buildReleaseMergePushPayload`）と同じ候補PRの詳細を開く
    url: `/dashboard?pane=pull-requests&pr=${encodeURIComponent(pullRequestId)}&mscreen=pull-requests`,
    tag: `release-merge:${pullRequestId}`,
  };
}

export async function sendReleaseCompletionStopPush(stop: ReleaseCompletionStopPush, now: Date = new Date()): Promise<void> {
  try {
    if (!isPushConfigured()) return;
    const repository = await db.repository.findFirst({
      where: { fullName: stop.repositoryFullName },
      select: { id: true, installationId: true },
    });
    if (!repository) return;
    const targets = await db.pushSubscription.findMany({
      where: {
        user: {
          userInstallations: { some: { installationId: repository.installationId } },
          hiddenRepositories: { none: { repositoryId: repository.id } },
          ...notMutedWhere("release-merge"),
        },
      },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    const key = { repositoryFullName: stop.repositoryFullName, pullRequestNumber: stop.pullRequestNumber };
    await db.releaseMergePushNotice.upsert({
      where: { repositoryFullName_pullRequestNumber: key },
      create: { ...key, notifiedAt: now },
      update: { notifiedAt: now },
    });
    if (targets.length === 0) return;
    await sendPushNotification(targets, buildReleaseCompletionStopPushPayload(stop));
  } catch (error) {
    console.error("[release-completion] 停止のPush通知に失敗しました", stop.repositoryFullName, stop.pullRequestNumber, error);
  }
}
