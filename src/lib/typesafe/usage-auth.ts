import { resolveSharedToken } from "@/lib/shared-token-reader";
import { authorizeBearerSecret, type SharedSecretAuthResult } from "@/lib/shared-secret-auth";

/**
 * ops-dashboardがTypeSafe使用量を読むための共有トークンを検証する。
 *
 * 呼び出し側は`TYPESAFE_USAGE_TOKEN`、提供側は既存の`OPS_API_TOKEN`として同じ値を持つ。
 * 値の正はops-dashboard側にあり、issue-deckへ新しいシークレットを複製しない。
 */
export async function authorizeTypeSafeUsage(
  authorizationHeader: string | null,
): Promise<SharedSecretAuthResult> {
  return authorizeBearerSecret(authorizationHeader, await resolveSharedToken("OPS_API_TOKEN", "OPS_API_TOKEN"));
}
