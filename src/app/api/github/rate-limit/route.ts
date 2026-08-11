import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchRateLimit } from "@/lib/github/rate-limit";

/**
 * インストールごとのGitHubレート制限を返す。
 *
 * RESTとGraphQLは別枠のため、枠ごとに返す（#1040）。Projects v2はGraphQL専用APIなので、
 * 進捗管理の消費はGraphQL側にしか現れない。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const userInstallations = await db.userInstallation.findMany({
    where: { userId },
    include: { installation: true },
  });

  const installations = await Promise.all(
    userInstallations.map(async ({ installation }) => {
      const token = await getInstallationToken(installation.installationId);
      const resources = await fetchRateLimit(token);
      return { accountLogin: installation.accountLogin, resources };
    }),
  );

  return NextResponse.json({ installations });
}
