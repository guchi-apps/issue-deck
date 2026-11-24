import { db } from "@/lib/db";
import { sendPushNotification, type PushNotificationPayload } from "@/lib/notifications/push";
import { notMutedWhere } from "@/lib/notifications/push-kinds";

/**
 * 外部エージェント用トークン（`ida_…`）の期限切れ予告（#5639）。
 *
 * 期限が切れると、AIDE経由のMCPツールが調査の最中に`401 token_expired`で全件失敗する。
 * 無人のまま期限を迎えて初めて気づく状態を避けるため、期限の`EXPIRY_NOTICE_DAYS`日前から
 * 発行した利用者へPush通知する。自動更新はしない（トークンの値は発行時に1度しか見せず、
 * 配布先のAIDE側の設定も人が書き換えるため）。
 *
 * 送信済みの記録は`ReviewAgentAuditLog`（`tool = token_expiry_notice`）へ1トークンにつき1行残す。
 * テーブルを増やさず、**送る前に記録して席を取る**（巡回が重なっても二重に鳴らさない。#2300と同じ）。
 * 期限は発行し直すと別のトークンになるので、再発行後は次の期限で改めて通知される。
 */

export const EXPIRY_NOTICE_DAYS = 14;
/** 期限が切れてからも、この日数までは「切れています」として1度だけ知らせる（巡回の取りこぼし対策） */
export const EXPIRED_NOTICE_GRACE_DAYS = 7;
export const EXPIRY_NOTICE_TOOL = "token_expiry_notice";

const DAY_MS = 86_400_000;

export type ExpiryNoticeCandidate = { id: string; name: string; expiresAt: Date; revokedAt: Date | null };

/** 通知の対象か。失効済みは対象外。期限の前日数以内、または切れて間もないもの */
export function isExpiryNoticeDue(token: ExpiryNoticeCandidate, now: Date): boolean {
  if (token.revokedAt) return false;
  const remaining = token.expiresAt.getTime() - now.getTime();
  return remaining <= EXPIRY_NOTICE_DAYS * DAY_MS && remaining > -EXPIRED_NOTICE_GRACE_DAYS * DAY_MS;
}

export function buildExpiryNoticePayload(token: { id: string; name: string; expiresAt: Date }, now: Date): PushNotificationPayload {
  const remaining = token.expiresAt.getTime() - now.getTime();
  const expired = remaining <= 0;
  const days = Math.max(1, Math.ceil(remaining / DAY_MS));
  return {
    title: expired ? "外部エージェント用トークンの期限が切れています" : `外部エージェント用トークンの期限が${days}日以内です`,
    body: `${token.name}（設定＞フリート運用で再発行し、AIDEなど利用側の設定を差し替えてください）`,
    url: "/dashboard",
    tag: `token-expiry:${token.id}`,
  };
}

export type ExpiryNoticeResult = { notified: string[] };

export async function runReviewAgentTokenExpiryNotice(now = new Date()): Promise<ExpiryNoticeResult> {
  const result: ExpiryNoticeResult = { notified: [] };
  const rows = await db.reviewAgentToken.findMany({
    where: {
      revokedAt: null,
      expiresAt: { lte: new Date(now.getTime() + EXPIRY_NOTICE_DAYS * DAY_MS), gt: new Date(now.getTime() - EXPIRED_NOTICE_GRACE_DAYS * DAY_MS) },
    },
    select: { id: true, userId: true, name: true, expiresAt: true, revokedAt: true },
  });
  for (const token of rows) {
    if (!isExpiryNoticeDue(token, now)) continue;
    const already = await db.reviewAgentAuditLog.findFirst({ where: { tokenId: token.id, tool: EXPIRY_NOTICE_TOOL }, select: { id: true } });
    if (already) continue;
    const targets = await db.pushSubscription.findMany({
      where: { user: { id: token.userId, ...notMutedWhere("token-expiry") } },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    // 宛先が無い（購読なし・OFF）ときは記録を付けず、購読が増えた次の巡回で送り直す
    if (targets.length === 0) continue;
    await db.reviewAgentAuditLog.create({ data: { tokenId: token.id, userId: token.userId, tool: EXPIRY_NOTICE_TOOL, outcome: "ok" } });
    await sendPushNotification(targets, buildExpiryNoticePayload(token, now));
    result.notified.push(token.id);
  }
  return result;
}
