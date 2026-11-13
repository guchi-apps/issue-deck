import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { countGithubApiCallsSince, getGithubApiUsageSummary } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchRateLimit } from "@/lib/github/rate-limit";

const HOUR_MS = 60 * 60_000;

/**
 * GitHub App（REST）の消費を機能×エンドポイント別に返す（#5367）。
 * 直近60分・正時起点の現在の1時間・直近24時間を、多い順に並べる。プロセス内の計測のため、
 * 再起動直後はDBから復元した分までしか遡れない（`measuringSince`で確認できる）。
 *
 * **`rateLimits`はGitHubが数えたインストール（トークン）単位の実消費**（#5373）。同じAppのトークンは
 * 各リポジトリのGitHub Actions（`actions/create-github-app-token`）も発行して使うため、そちらの消費は
 * プロセス内の計測に載らない。GitHubの窓（`reset`の1時間前から）に入る計測ぶんを`measuredInWindow`、
 * `used`との差を`unmeasuredInWindow`として返す。計測はインストールを区別しないため、インストールが
 * 複数あるとそれぞれの`measuredInWindow`には他のインストールの呼び出しも混ざる（目安として読む）。
 * `/rate_limit`自体は枠を消費しない。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = Date.now();
  const installations = await db.githubInstallation.findMany({
    where: { userInstallations: { some: { userId } }, suspendedAt: null },
  });

  const rateLimits = await Promise.all(
    installations.map(async (installation) => {
      try {
        const token = await getInstallationToken(installation.installationId);
        const core = (await fetchRateLimit(token)).find((resource) => resource.key === "core");
        if (!core) return { accountLogin: installation.accountLogin, error: "core_missing" as const };
        const windowStartedAt = core.reset * 1000 - HOUR_MS;
        const measuredInWindow = countGithubApiCallsSince(windowStartedAt, now);
        return {
          accountLogin: installation.accountLogin,
          used: core.used,
          limit: core.limit,
          remaining: core.remaining,
          reset: core.reset,
          windowStartedAt,
          measuredInWindow,
          unmeasuredInWindow: Math.max(0, core.used - measuredInWindow),
        };
      } catch (error) {
        console.warn(`[GET /api/github/api-usage] ${installation.accountLogin}のレート制限を取得できませんでした`, error);
        return { accountLogin: installation.accountLogin, error: "fetch_failed" as const };
      }
    }),
  );

  return NextResponse.json(
    { ...getGithubApiUsageSummary(now), rateLimits },
    { headers: { "Cache-Control": "no-store" } },
  );
}
