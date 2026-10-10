import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import http2 from "node:http2";

/**
 * APNs（Apple Push Notification service）の送信口（#4250）。
 *
 * iOSアプリ（WKWebView）ではWeb Push（`public/sw.js`）が動かないため、アプリが取得した
 * 端末トークンへ直接送る。**依存は足さず**、Node標準の`http2`・`crypto`でトークン方式
 * （JWT／ES256）の認証を行う。
 *
 * 宛先は`PushSubscription`の行へ`endpoint = "apns:<端末トークン>"`で相乗りさせる
 * （マイグレーションを避けるため）。`sendPushNotification`（`push.ts`）がこの接頭辞で
 * 振り分けるので、呼び出し側は種別を意識しない。
 *
 * **設定が揃っていなければ何もしない**（VAPID未設定時と同じ）。値はサーバーの`.env`から読む。
 */

export const APNS_ENDPOINT_PREFIX = "apns:";

/** `apns-topic`。アプリのBundle ID */
export const APNS_TOPIC = "com.gucchii.issuedeck";

export type ApnsEnvironment = "production" | "sandbox";

export type ApnsConfig = {
  /** `.p8`の中身（PEM）。`.env`では改行を`\n`の2文字で書いてもよい */
  keyPem: string;
  keyId: string;
  teamId: string;
  environment: ApnsEnvironment;
};

export function getApnsConfig(): ApnsConfig | null {
  const keyPem = process.env.APNS_KEY_P8?.trim().replace(/\\n/g, "\n");
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  if (!keyPem || !keyId || !teamId) return null;
  // TestFlight・App Storeは本番、Xcodeからの実機デバッグはサンドボックス。取り違えると
  // BadDeviceTokenになるので、既定は本番（配布ビルドが主）で明示的に切り替えさせる
  const environment: ApnsEnvironment =
    process.env.APNS_ENVIRONMENT?.trim() === "sandbox" ? "sandbox" : "production";
  return { keyPem, keyId, teamId, environment };
}

export function isApnsConfigured(): boolean {
  return getApnsConfig() !== null;
}

export function isApnsEndpoint(endpoint: string): boolean {
  return endpoint.startsWith(APNS_ENDPOINT_PREFIX);
}

export function apnsEndpoint(deviceToken: string): string {
  return `${APNS_ENDPOINT_PREFIX}${deviceToken}`;
}

/** 端末トークン（16進文字列）。長さは将来の延長に備えて余裕を持たせた上限 */
export const APNS_DEVICE_TOKEN_PATTERN = /^[0-9a-fA-F]{32,200}$/;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** ES256のJWT。`dsaEncoding: ieee-p1363`でJWS形式（r||s）の署名にする */
export function createApnsJwt(config: ApnsConfig, issuedAtSeconds: number, key?: KeyObject): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: issuedAtSeconds }));
  const signingInput = `${header}.${claims}`;
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key: key ?? createPrivateKey(config.keyPem), dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

/** Appleは同じJWTを20分〜1時間の範囲で使い回すことを求める（頻繁な再発行はTooManyProviderTokenUpdates） */
const JWT_TTL_SECONDS = 50 * 60;
let cachedJwt: { token: string; cacheKey: string; issuedAt: number } | null = null;

function providerToken(config: ApnsConfig, nowSeconds: number): string {
  const cacheKey = `${config.teamId}:${config.keyId}`;
  if (cachedJwt && cachedJwt.cacheKey === cacheKey && nowSeconds - cachedJwt.issuedAt < JWT_TTL_SECONDS) {
    return cachedJwt.token;
  }
  const token = createApnsJwt(config, nowSeconds);
  cachedJwt = { token, cacheKey, issuedAt: nowSeconds };
  return token;
}

export type ApnsPayload = {
  title: string;
  body: string;
  /** タップで開くパス。アプリが`AppConfig.baseURL`へ解決して開く */
  url: string;
  /** 同じ鍵の通知を置き換える・スレッドでまとめる */
  tag: string;
};

export type ApnsSendOutcome =
  | { kind: "sent" }
  /** 端末トークンが無効（アプリ削除など）。行を消してよい */
  | { kind: "gone" }
  | { kind: "failed"; status: number | null; reason: string | null };

/**
 * 失効として消してよいか。**410と`Unregistered`だけ**。`BadDeviceToken`は、サンドボックスと
 * 本番の取り違えでも出るため、消すと正しい端末を失う
 */
export function classifyApnsResponse(status: number | null, reason: string | null): ApnsSendOutcome {
  if (status === 200) return { kind: "sent" };
  if (status === 410 || reason === "Unregistered") return { kind: "gone" };
  return { kind: "failed", status, reason };
}

/** `apns-collapse-id`は64バイトまで。超える鍵は切り詰める */
function collapseId(tag: string): string {
  return Buffer.from(tag).subarray(0, 64).toString("utf8").replace(/�/g, "");
}

function host(environment: ApnsEnvironment): string {
  return environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
}

/** 1つの接続で複数の端末へ送る。例外は投げず、トークンごとの結果を返す */
export async function sendApnsNotifications(
  deviceTokens: readonly string[],
  payload: ApnsPayload,
  config: ApnsConfig,
): Promise<Map<string, ApnsSendOutcome>> {
  const outcomes = new Map<string, ApnsSendOutcome>();
  if (deviceTokens.length === 0) return outcomes;

  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: "default",
      "thread-id": payload.tag,
    },
    url: payload.url,
  });
  const jwt = providerToken(config, Math.floor(Date.now() / 1000));

  let client: http2.ClientHttp2Session;
  try {
    client = http2.connect(host(config.environment));
  } catch (error) {
    console.error("[apns] 接続できませんでした", error);
    for (const token of deviceTokens) outcomes.set(token, { kind: "failed", status: null, reason: "connect" });
    return outcomes;
  }
  // 接続の失敗は各リクエストのerrorで拾う。ここで握らないとプロセスが落ちる
  client.on("error", () => {});

  await Promise.all(
    deviceTokens.map(
      (deviceToken) =>
        new Promise<void>((resolve) => {
          const request = client.request({
            ":method": "POST",
            ":path": `/3/device/${deviceToken}`,
            authorization: `bearer ${jwt}`,
            "apns-topic": APNS_TOPIC,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-collapse-id": collapseId(payload.tag),
            // 確認待ちは半日残ることもあるので、Web Pushと同じく24時間配送を試みる
            "apns-expiration": String(Math.floor(Date.now() / 1000) + 60 * 60 * 24),
          });
          let status: number | null = null;
          let responseBody = "";
          request.setTimeout(10_000, () => request.close(http2.constants.NGHTTP2_CANCEL));
          request.on("response", (headers) => {
            status = Number(headers[":status"]) || null;
          });
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            responseBody += chunk;
          });
          request.on("error", () => {
            outcomes.set(deviceToken, { kind: "failed", status, reason: "request" });
            resolve();
          });
          request.on("close", () => {
            if (!outcomes.has(deviceToken)) {
              let reason: string | null = null;
              try {
                reason = (JSON.parse(responseBody) as { reason?: string }).reason ?? null;
              } catch {
                reason = null;
              }
              outcomes.set(deviceToken, classifyApnsResponse(status, reason));
            }
            resolve();
          });
          request.end(body);
        }),
    ),
  );

  client.close();
  return outcomes;
}
