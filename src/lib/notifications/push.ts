import { createHash } from "node:crypto";

import webpush from "web-push";

import { db } from "@/lib/db";

/**
 * Web Push（#838）の送信口。**購読の宛先を知っているのはここだけ**で、呼び出し側は
 * 「誰に何を送るか」だけを決める。
 *
 * 送るのは`00.check-user`が付いた確認待ちの知らせ1種類だけ（`check-user-push.ts`）。
 * **送った通知はService Worker（`public/sw.js`）が必ずOSの通知として出す**——
 * アプリを開いているかどうかで出し分けない（#2196。出さないpushが続くとiOSは購読を
 * 失効させる）。二重にしないための調整は画面側にあり、通知が届いている端末では
 * 画面内のトーストを出さない（`use-push-delivery.ts`）。
 *
 * **鍵（VAPID）が未設定でもアプリは動く。** 未設定なら送信は何もせずに終わり、設定画面は
 * 「利用できません」を出す。本番へ鍵を入れるまでのあいだ、他の機能を巻き込まないため。
 */

export type VapidConfig = {
  publicKey: string;
  privateKey: string;
  /** RFC 8292のsub。`mailto:`かアプリのURLを入れる */
  subject: string;
};

/** 通知1件の中身。Service Workerがそのまま読む形にしておく（向こうで組み立て直さない） */
export type PushNotificationPayload = {
  title: string;
  body: string;
  /**
   * 通知をタップしたときに開くパス。PC（`issue`）とスマホ（`mscreen`・`missue`）で
   * 現在地の持ち方が違うため、`useReferenceNavigation`と同じく両方を載せる
   */
  url: string;
  /**
   * OS側の通知をまとめる鍵。同じIssueの通知が続けて届いたときに古い方を置き換える
   * （鳴り続けるより、最新の1件が残る方が読み取れる）
   */
  tag: string;
};

/** 送信結果。件数だけを返し、宛先そのものは呼び出し側へ漏らさない */
export type PushSendResult = {
  sent: number;
  /** 失効（404/410）として削除した購読の数 */
  removed: number;
  /** 失効以外の理由で送れなかった数 */
  failed: number;
};

/**
 * VAPIDの設定。3つ揃っていなければnull（＝Push通知は使えない）。
 *
 * 値は`.env`から読む。鍵の生成と本番への設定はユーザーの手作業で、生成は
 * `npx web-push generate-vapid-keys`。
 */
export function getVapidConfig(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** サーバー側でPush通知を送れる状態か。設定画面の「利用できません」の判定もこれを見る */
export function isPushConfigured(): boolean {
  return getVapidConfig() !== null;
}

/**
 * 購読の宛先URLから一意キーを作る。
 *
 * `endpoint`は数百文字になることがあり、MySQLでは`TEXT`に一意インデックスを張れない。
 * 同じ端末から登録し直したときに行を増やさないため、ハッシュを一意キーにしている。
 */
export function pushEndpointKey(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

/** 送信に必要な購読の情報。DBの行をそのまま渡せる形にしておく */
export type PushTarget = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/**
 * 購読が失効していて、行を消してよいか。
 *
 * Pushサービスは、ブラウザ側で購読が捨てられた宛先へ送ると404か410を返す。それ以外
 * （ネットワークの失敗・5xx・レート制限）は**一時的な失敗として消さない**——消してしまうと、
 * 次に確認待ちになったときに届く先が無くなり、しかもユーザーには何も起きていないように見える。
 */
function isGonePushError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  return statusCode === 404 || statusCode === 410;
}

/**
 * 購読へ通知を送る。**失効した購読はここで消す。**
 *
 * 1件の失敗で残りを止めない（別の端末には届けたい）。例外は投げず、件数だけを返す。
 */
export async function sendPushNotification(
  targets: readonly PushTarget[],
  payload: PushNotificationPayload,
): Promise<PushSendResult> {
  const result: PushSendResult = { sent: 0, removed: 0, failed: 0 };
  if (targets.length === 0) return result;

  const vapid = getVapidConfig();
  if (!vapid) return result;

  const body = JSON.stringify(payload);
  const goneIds: string[] = [];

  await Promise.all(
    targets.map(async (target) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: target.endpoint,
            keys: { p256dh: target.p256dh, auth: target.auth },
          },
          body,
          {
            vapidDetails: {
              subject: vapid.subject,
              publicKey: vapid.publicKey,
              privateKey: vapid.privateKey,
            },
            // 端末が電源を落としていても、しばらくは配送を試みてほしい。
            // 確認待ちは半日残ることもあるので、24時間持たせる
            TTL: 60 * 60 * 24,
          },
        );
        result.sent += 1;
      } catch (error) {
        if (isGonePushError(error)) {
          goneIds.push(target.id);
          result.removed += 1;
          return;
        }
        result.failed += 1;
        console.error("[push] 通知を送れませんでした", error);
      }
    }),
  );

  if (goneIds.length > 0) {
    await db.pushSubscription.deleteMany({ where: { id: { in: goneIds } } });
  }

  return result;
}
