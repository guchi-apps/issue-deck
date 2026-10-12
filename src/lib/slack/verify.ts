import { createHmac, timingSafeEqual } from "node:crypto";

/** タイムスタンプの許容幅（秒）。Slackの推奨は5分 */
export const SLACK_TIMESTAMP_TOLERANCE_SEC = 5 * 60;

/**
 * Slackの署名検証（`v0=HMAC-SHA256("v0:{ts}:{rawBody}")`）。**生のボディ**で検証すること。
 * 署名の不一致・時刻のずれ・ヘッダー欠落はすべて偽を返す（理由は呼び出し側へ出さない）。
 */
export function verifySlackSignature(params: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  signingSecret: string;
  nowSec?: number;
}): boolean {
  const { rawBody, timestamp, signature, signingSecret } = params;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  const now = params.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > SLACK_TIMESTAMP_TOLERANCE_SEC) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
