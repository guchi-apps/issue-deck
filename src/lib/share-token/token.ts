import { hashToken, randomToken } from "@/lib/native-auth/tokens";

/**
 * iOS共有画面用トークンの純関数（#4298）。DBに触れる処理は`auth.ts`に置く。
 * 値は`idsh_`＋256bitランダム。`Authorization`に載ったとき、他のBearer（共有シークレット）と見分ける。
 */

export const SHARE_TOKEN_PREFIX = "idsh_";
export const SHARE_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function issueShareTokenValue(): { value: string; hash: string } {
  const value = `${SHARE_TOKEN_PREFIX}${randomToken()}`;
  return { value, hash: hashToken(value) };
}

export function parseDeviceId(value: unknown): string | null {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value) ? value : null;
}

/** `Authorization: Bearer idsh_…`から値を取り出す。形式が違えばnull */
export function extractShareToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer (idsh_[A-Za-z0-9_-]{43})$/.exec(authorization.trim());
  return match ? match[1] : null;
}

export function hashShareToken(value: string): string {
  return hashToken(value);
}

/** 仮タイトル（タイトル空欄で作るとき）。本文の先頭行、URLだけなら「共有: ホスト名」 */
export function provisionalTitle(body: string): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("!["));
  if (!firstLine) return "共有された内容";
  if (/^https?:\/\/\S+$/.test(firstLine)) {
    try {
      return `共有: ${new URL(firstLine).hostname}`;
    } catch {
      return "共有された内容";
    }
  }
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}
