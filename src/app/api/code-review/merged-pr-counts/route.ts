import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  fetchMergedPullRequestCount,
  getMergedPullRequestCountCache,
  parseMergedPullRequestRangeKey,
  setMergedPullRequestCountCache,
  type MergedPullRequestRange,
} from "@/lib/github/merged-pr-count";

/**
 * 「コードレビュー」ビューのリポジトリ別の枠（#3092）に出す、期間ごとに入ったPRの件数。
 *
 * 期間は`range`クエリで複数受ける（`owner/repo|from|to`。`mergedPullRequestRangeKey`の形）。
 * **ポーリングはしない**——ビューを開いたとき・レビューが増えたときに画面が1回だけ引く。
 * 件数は検索APIの`total_count`で、30回/分の制限があるため1回に受ける期間に上限を置き、
 * プロセス内キャッシュ（`merged-pr-count.ts`）から返せるものはGitHubへ行かない。
 */

/** 1回で受け付ける期間の上限。検索APIの30回/分を1回の表示で使い切らない */
const MAX_RANGES = 25;

export function GET(request: NextRequest) {
  return withGithubApiFeature("code_review_merged_prs", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const requested = [
    ...new Map(
      searchParams
        .getAll("range")
        .map((value) => [value, parseMergedPullRequestRangeKey(value)] as const)
        .filter((entry): entry is readonly [string, MergedPullRequestRange] => entry[1] !== null),
    ),
  ].slice(0, MAX_RANGES);

  if (requested.length === 0) {
    return NextResponse.json({ counts: [] });
  }

  // 数えてよいのは、このユーザーが接続しているリポジトリだけ
  const repositories = await db.repository.findMany({
    where: {
      fullName: { in: [...new Set(requested.map(([, range]) => range.repositoryFullName))] },
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
  const repositoryByFullName = new Map(repositories.map((row) => [row.fullName, row]));

  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const counts = await Promise.all(
    requested.map(async ([key, range]) => {
      const repository = repositoryByFullName.get(range.repositoryFullName);
      if (!repository) return null;

      // 数えるのは既定ブランチ（fleetでは`develop`）へ入ったPRだけ（`merged-pr-count.ts`）
      const baseBranch = repository.defaultBranch;
      const cached = getMergedPullRequestCountCache(range, baseBranch);
      if (cached !== null) return { key, count: cached };

      try {
        const token = await tokenFor(repository.installation.installationId);
        const count = await fetchMergedPullRequestCount(range, baseBranch, token);
        if (count === null) return null;
        setMergedPullRequestCountCache(range, baseBranch, count);
        return { key, count };
      } catch (error) {
        // 1件取れなくても他の行の件数は出す。取れなかった行は「—」になるだけ
        console.error(`[GET /api/code-review/merged-pr-counts] ${key}:`, error);
        return null;
      }
    }),
  );

  return NextResponse.json({ counts: counts.filter((entry) => entry !== null) });
}
