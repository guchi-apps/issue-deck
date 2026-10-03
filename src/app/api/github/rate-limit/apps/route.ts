import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchRateLimit } from "@/lib/github/rate-limit";
import { authorizeTypeSafeUsage } from "@/lib/typesafe/usage-auth";

/**
 * 全インストールのGitHubレート制限を、サーバー間（StatusHubなど）へ返す（#3830）。
 *
 * 応答の形は`GET /api/github/rate-limit`と同じ。セッションのユーザーには依存せず、
 * `OPS_API_TOKEN`のBearerだけで読める（新しいシークレットは増やさない）。
 */
export async function GET(request: NextRequest) {
  const auth = await authorizeTypeSafeUsage(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const allInstallations = await db.githubInstallation.findMany();

  const installations = await Promise.all(
    allInstallations.map(async (installation) => {
      const token = await getInstallationToken(installation.installationId);
      const resources = await fetchRateLimit(token);
      return { accountLogin: installation.accountLogin, resources };
    }),
  );

  return NextResponse.json({ installations }, { headers: { "Cache-Control": "no-store" } });
}
