import { authorizeBearerSecret, type SharedSecretAuthResult } from "@/lib/shared-secret-auth";
import { resolveSharedToken } from "@/lib/shared-token-reader";

/**
 * VPSメモリ計測API（#4256）の認証。
 *
 * - 書き込み（サブPCのprobe）: ディスパッチAPIと同じ`DISPATCH_SECRET`。サブPCが既に持つ鍵で、
 *   同じ信頼境界のため新しい値を増やさない
 * - 読み取り（AIDEのMCP）: 専用の共有トークン`ISSUE_DECK_VPS_MEMORY_TOKEN`（無ければ`VPS_MEMORY_READ_SECRET`）。
 *   読み取り専用の鍵なので書き込み鍵と分け、漏洩時に止める範囲を閉じる（`aide-summary-auth.ts`と同じ方針）
 */
export function authorizeVpsMemoryWrite(authorizationHeader: string | null): SharedSecretAuthResult {
  return authorizeBearerSecret(authorizationHeader, process.env.DISPATCH_SECRET);
}

export async function authorizeVpsMemoryRead(authorizationHeader: string | null): Promise<SharedSecretAuthResult> {
  return authorizeBearerSecret(
    authorizationHeader,
    await resolveSharedToken("ISSUE_DECK_VPS_MEMORY_TOKEN", "VPS_MEMORY_READ_SECRET"),
  );
}
