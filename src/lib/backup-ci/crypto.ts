import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** バックアップCI（#4065）のうち、サーバーでしか使えない（node:cryptoに依存する）計算 */

/** 定義ファイルの生バイトのsha256。scripts/ci/run-required-checks.mjs の`digestDefinition`と同じ計算 */
export function digestDefinition(raw: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/**
 * CircleCIのOutbound Webhookの署名（`circleci-signature: v1=<hex>`）を検証する。
 * 複数の版がカンマ区切りで並ぶことがあるため、`v1=`のどれかが一致すればよい。
 */
export function verifyCircleciSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  for (const part of header.split(",")) {
    const [version, value] = part.trim().split("=", 2);
    if (version !== "v1" || !value || !/^[0-9a-f]+$/i.test(value)) continue;
    const actual = Buffer.from(value, "hex");
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true;
  }
  return false;
}
