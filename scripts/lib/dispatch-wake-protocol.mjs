// ジョブ即時通知（#4200）の署名・検証。送り手（VPSのissue-deck。src/lib/dispatch/wake-notify.ts）と
// 受け手（サブPCの scripts/dispatch-wake-receiver.mjs）で同じ手順を使う。
//
// **通知は「キューを見に行け」の合図だけ。** 本文を持たず、受け手は署名が正しければ
// 起床ファイルを更新するだけで、コマンド・プロンプトを受け取る口は無い。
// 鍵は既存の`DISPATCH_SECRET`から用途別に派生させる（新しい秘密値を増やさない。
// 派生鍵が漏れても、`DISPATCH_SECRET`そのものやclaim用の認証には使えない）。
import { createHmac, timingSafeEqual } from "node:crypto";

export const WAKE_PROTOCOL_VERSION = "issue-deck-wake-v1";
export const WAKE_MAX_SKEW_MS = 60_000;
export const WAKE_PATH = "/wake";

export function deriveWakeKey(dispatchSecret) {
  return createHmac("sha256", dispatchSecret).update(WAKE_PROTOCOL_VERSION).digest();
}

/** 署名の対象は「宛先ホスト名」と「送信時刻（ms）」だけ。別ホスト宛の通知は流用できない */
export function signWake(dispatchSecret, hostName, timestampMs) {
  return createHmac("sha256", deriveWakeKey(dispatchSecret))
    .update(`${hostName}.${timestampMs}`)
    .digest("hex");
}

/** @returns {{ ok: true, timestampMs: number } | { ok: false, reason: string }} */
export function verifyWake({ dispatchSecret, hostName, timestamp, signature, nowMs = Date.now() }) {
  if (!dispatchSecret) return { ok: false, reason: "not_configured" };
  if (typeof timestamp !== "string" || !/^\d{10,16}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const timestampMs = Number(timestamp);
  if (Math.abs(nowMs - timestampMs) > WAKE_MAX_SKEW_MS) return { ok: false, reason: "expired" };
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: "bad_signature" };
  const expected = Buffer.from(signWake(dispatchSecret, hostName, timestampMs), "hex");
  const actual = Buffer.from(signature, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, timestampMs };
}
