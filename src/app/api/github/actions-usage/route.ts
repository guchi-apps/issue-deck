import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchActionsUsage, type ActionsUsageEntry } from "@/lib/github/actions-billing";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { GithubApiError } from "@/lib/github/github-api-error";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";

/**
 * インストールごとのGitHub Actionsの消費量（今月の実行時間・課金額）を返す。
 *
 * **ユーザー本人のトークンで読む。** organizationの課金レポートはGitHub Appの
 * インストールトークンでは読めない（`lib/github/actions-billing.ts`）。
 *
 * **個人アカウントのインストールは`unsupported`で返す。** 別エンドポイント＋`user`スコープが
 * 要るため取得しない。表示から消すのではなく理由を出したいので、行そのものは残す。
 */

export function GET() {
  return withGithubApiFeature("actions_billing", handleGET);
}

async function handleGET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const userInstallations = await db.userInstallation.findMany({
    where: { userId: user.id },
    include: { installation: true },
  });

  const result = await withUserGithubToken(user, "GET /api/github/actions-usage", async (token) => {
    const entries: ActionsUsageEntry[] = [];
    for (const { installation } of userInstallations) {
      if (installation.accountType !== "ORGANIZATION") {
        entries.push({
          accountLogin: installation.accountLogin,
          usage: null,
          errorStatus: null,
          unsupported: true,
        });
        continue;
      }

      const usage = await fetchActionsUsage(installation.accountLogin, token);
      // 401は`withUserGithubToken`にトークンの延長・再ログイン導線を任せるため、例外にして預ける。
      if (!usage.ok && usage.status === 401) {
        throw new GithubApiError(401, `GitHub billing usage failed: 401 ${installation.accountLogin}`);
      }
      entries.push({
        accountLogin: installation.accountLogin,
        usage: usage.ok ? usage.usage : null,
        errorStatus: usage.ok ? null : usage.status,
        unsupported: false,
      });
    }
    return entries;
  });

  if ("errorResponse" in result) {
    return result.errorResponse;
  }

  return NextResponse.json({ installations: result.value });
}
