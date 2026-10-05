import type { User } from "@supabase/supabase-js";

import {
  createAccessClient,
  parseAccessResponse,
  type AccessDecision,
  type AccessFetcher,
  type AccessSubject,
} from "@/lib/access/decision";
import { clearSharedTokenReaderCache, readSharedTokenValue } from "@/lib/shared-token-reader";

const TIMEOUT_MS = 5_000;

const TOKEN_NAME = "ISSUE_DECK_ACCESS_APP_TOKEN";
/** StatusHub の本番オリジン。`ACCESS_API_URL` は開発などで別の宛先へ向けるときだけ使う。 */
const DEFAULT_ACCESS_API_URL = "https://admin.gucchii.com";

/**
 * StatusHub の判定APIを呼ぶ。管理画面の「トークン発行」がissue-deckの共有トークン
 * `ISSUE_DECK_ACCESS_APP_TOKEN` へ書き込んだアプリ別トークンを、自分のDBから読む。
 * トークンが無ければ通信せず失敗として扱う＝一度も判定できないので全員拒否になる
 * （未設定が「誰でも通す」に化けない。旧`ALLOWED_EMAILS`へはフォールバックしない）。
 * 再発行で古いトークンは即失効するため、401ならキャッシュを捨てて読み直し、1回だけ再試行する。
 * トークンの値はログへ出さない。
 */
async function post(baseUrl: string, token: string, body: Parameters<AccessFetcher>[0]): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/+$/, "")}/api/access/v1/decision`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

const fetcher: AccessFetcher = async (body) => {
  const baseUrl = process.env.ACCESS_API_URL || DEFAULT_ACCESS_API_URL;
  const token = (await readSharedTokenValue(TOKEN_NAME))?.trim();
  if (!token) throw new Error(`${TOKEN_NAME} が未設定`);

  let response = await post(baseUrl, token, body);
  if (response.status === 401) {
    clearSharedTokenReaderCache();
    const renewed = (await readSharedTokenValue(TOKEN_NAME))?.trim();
    if (renewed && renewed !== token) response = await post(baseUrl, renewed, body);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseAccessResponse(await response.json(), body.subject !== undefined);
};

// 開発サーバーの再読み込みで状態が消えないよう globalThis に置く（instrumentation と route が同じ状態を見る）。
const globalForAccess = globalThis as unknown as { __issueDeckAccess?: ReturnType<typeof createAccessClient> };

function client() {
  globalForAccess.__issueDeckAccess ??= createAccessClient(fetcher, undefined, Date.now, (error) => {
    console.error("[issue-deck] アクセス判定の取得に失敗:", error instanceof Error ? error.message : error);
  });
  return globalForAccess.__issueDeckAccess;
}

type AccessUser = Pick<User, "id" | "email" | "email_confirmed_at" | "user_metadata">;

/**
 * Supabase が検証したユーザーから、判定APIへ送る主体を作る。
 * メールが確認済みかは Supabase の確認時刻・プロバイダの email_verified から決める
 * （ブラウザの申告ではなく、サーバーが検証したセッションの値だけを使う）。
 */
export function toAccessSubject(user: AccessUser): AccessSubject {
  const verified = user.user_metadata?.email_verified === true || Boolean(user.email_confirmed_at);
  return { sub: user.id, email: user.email ?? "", emailVerified: verified };
}

export async function decideAccess(subject: AccessSubject): Promise<AccessDecision> {
  return client().decide(subject);
}

export async function isUserAllowed(user: AccessUser | null | undefined): Promise<boolean> {
  if (!user) return false;
  return (await decideAccess(toAccessSubject(user))).allowed;
}

export async function sendAccessHeartbeat(): Promise<boolean> {
  return client().heartbeat();
}
