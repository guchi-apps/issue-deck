import { db } from "@/lib/db";
import { loadSharedTokenAlertDiscordTarget, postWebhookMessage } from "@/lib/discord/webhook";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { isUnexpectedConsumer, readExpectedConsumers } from "@/lib/shared-tokens";

/**
 * 想定外の利用元が共有トークンを取得したときのDiscord通知（#4998）。
 *
 * `X-Shared-Token-Consumer`は認証ではなく自己申告で、`SHARED_TOKEN_API_SECRET`を持つ者は
 * 名前さえ分かれば全トークンを取得できる。**通知が出る時点で値は取得済み**なので、
 * これは止める仕組みではなく気づくための仕組み。想定内の名前を名乗られると検知できない。
 *
 * - 想定利用元が未設定のトークンは対象外（重要なものから設定して段階的に広げる）
 * - 本文はトークン名・利用元・時刻だけで、値は含めない
 * - 同じトークン×利用元の組は`SHARED_TOKEN_ALERT_INTERVAL_MS`に1回だけ鳴らす。記録はDBに置き、
 *   再起動・複数プロセスでも重複しないよう、条件付き更新で「鳴らす権利」を1つだけ取る
 * - 投稿先は専用の`DISCORD_SHARED_TOKEN_ALERT_WEBHOOK_URL`。未設定ならリリース通知の`DISCORD_RELEASE_WEBHOOK_URL`へ退避する
 */

export const SHARED_TOKEN_ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type SharedTokenAlertResult = "expected" | "not_configured" | "suppressed" | "notified" | "failed";

type AlertTarget = { id: string; name: string; expectedConsumers: unknown };

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

/** 鳴らす権利を取る。初回は行を作り、2回目以降は前回から間隔が空いているときだけ更新できる */
async function claimAlert(sharedTokenId: string, consumer: string, now: Date): Promise<boolean> {
  try {
    await db.sharedTokenConsumerAlert.create({ data: { sharedTokenId, consumer, lastNotifiedAt: now } });
    return true;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }
  const { count } = await db.sharedTokenConsumerAlert.updateMany({
    where: {
      sharedTokenId,
      consumer,
      lastNotifiedAt: { lt: new Date(now.getTime() - SHARED_TOKEN_ALERT_INTERVAL_MS) },
    },
    data: { lastNotifiedAt: now },
  });
  return count > 0;
}

export async function notifyUnexpectedSharedTokenConsumer(
  token: AlertTarget,
  rawConsumer: string,
  {
    now = new Date(),
    env = process.env,
    fetchImpl = fetch,
  }: { now?: Date; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {},
): Promise<SharedTokenAlertResult> {
  if (!isUnexpectedConsumer(readExpectedConsumers(token.expectedConsumers), rawConsumer)) return "expected";
  const target = loadSharedTokenAlertDiscordTarget(env);
  if (!target) return "not_configured";

  const consumer = rawConsumer.trim().toLowerCase();
  if (!(await claimAlert(token.id, consumer, now))) return "suppressed";

  try {
    await postWebhookMessage(
      target.webhookUrl,
      {
        threadName: `共有トークン警告 ${token.name}`,
        embeds: [
          {
            title: "想定外の利用元による共有トークンの取得",
            color: 0xf59e0b,
            timestamp: now.toISOString(),
            fields: [
              { name: "トークン", value: token.name },
              { name: "利用元", value: rawConsumer.trim() },
              { name: "時刻", value: formatJst(now) },
            ],
            footer: { text: "同じトークン・利用元の組は24時間に1回だけ通知します" },
          },
        ],
      },
      fetchImpl,
    );
    return "notified";
  } catch {
    // 投稿できなかったら権利を返し、次の取得で鳴らし直す
    await db.sharedTokenConsumerAlert
      .updateMany({ where: { sharedTokenId: token.id, consumer, lastNotifiedAt: now }, data: { lastNotifiedAt: new Date(0) } })
      .catch(() => undefined);
    console.warn(`[shared-token-alert] 想定外の利用元の通知に失敗しました（${token.name} / ${consumer}）`);
    return "failed";
  }
}
