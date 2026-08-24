import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchActionsUsage, type ActionsUsageEntry } from "@/lib/github/actions-billing";
import { withGithubApiFeature } from "@/lib/github/api-usage";

/**
 * インストールごとのGitHub Actionsの消費量（今月の実行時間・課金額）を返す。
 *
 * **専用のトークン（`GITHUB_BILLING_TOKEN`）で読む。** organizationの課金レポートは
 * **classicのOAuthトークン・PATでしか読めず**、issue-deckが持っている2種類のトークンは
 * どちらも使えない（#2212で実測）。
 *
 * - GitHub Appのインストールトークン: `403 Resource not accessible by integration`
 * - ユーザー本人のトークン: Supabase Authが使っているのはGitHub App（`client_id`が`Iv23li…`）
 *   なので、これもuser-to-serverトークン。`signInWithOAuth`の`scopes`はGitHubに無視される
 *
 * **未設定ならこの表示だけを無効にする**（501）。Claudeプラン使用量（`/api/claude/usage`）と
 * 同じ扱いで、アプリ自体は動く。
 *
 * **個人アカウントのインストールは`unsupported`で返す。**
 * `/users/{username}/settings/billing/usage`は`user`スコープを要求する別のエンドポイントで、
 * このトークンでは読めない。表示から消すのではなく理由を出したいので、行そのものは残す。
 */

export function GET() {
  return withGithubApiFeature("actions_billing", handleGET);
}

async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.GITHUB_BILLING_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "not_configured" }, { status: 501 });
  }

  const userInstallations = await db.userInstallation.findMany({
    where: { userId },
    include: { installation: true },
  });

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
    entries.push({
      accountLogin: installation.accountLogin,
      usage: usage.ok ? usage.usage : null,
      errorStatus: usage.ok ? null : usage.status,
      unsupported: false,
    });
  }

  return NextResponse.json({ installations: entries });
}
