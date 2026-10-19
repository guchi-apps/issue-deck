import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { fetchPullRequestCommits } from "@/lib/github/pull-requests-api";
import { fetchOpenPullRequestsForBase } from "@/lib/github/release-api";
import type { ReleaseCandidate } from "@/lib/release-candidate-checks";
import { toReleaseChanges } from "@/lib/release-changes";
import { isReleasePullRequest } from "@/lib/release-merge-gate";
import { loadReleaseVerificationSummary } from "@/lib/release-verification-load";

/**
 * リポジトリのopenなリリース候補（base=main・head=`release-main/v*`）と、各候補が含むPR番号・検証結果（#4366）。
 *
 * PR詳細・PR一覧・ブランチ画面が、各PRの「全体レビュー・統合検証・iOS検証」を**同じ候補・同じSHA**で
 * 引くための読み取り専用の取得。**検証は起動しない**（表示のために二重起動しない）。候補が無ければ
 * `candidates`は空で、画面は「リリース未作成」と出す。取得に失敗したら502（空の一覧にしない）。
 */
export function GET(request: NextRequest) {
  return withGithubApiFeature("release_status", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  if (!owner || !repo) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const repository = await db.repository.findFirst({
    where: { fullName: `${owner}/${repo}`, installation: { userInstallations: { some: { userId } } } },
    include: { installation: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const open = await fetchOpenPullRequestsForBase(owner, repo, "main", token);
    const releases = open.flatMap((pr) =>
      pr.base && isReleasePullRequest({ baseRef: pr.base.ref, headRef: pr.head.ref })
        ? [{ ...pr, base: pr.base }]
        : [],
    );
    const candidates: ReleaseCandidate[] = await Promise.all(
      releases.map(async (pr) => {
        const commits = await fetchPullRequestCommits(owner, repo, pr.number, token);
        const { pullRequests } = toReleaseChanges(
          commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message })),
        );
        const current = { baseSha: pr.base.sha, headSha: pr.head.sha };
        return {
          number: pr.number,
          title: pr.title,
          headRef: pr.head.ref,
          baseSha: current.baseSha,
          headSha: current.headSha,
          pullRequestNumbers: pullRequests.map((change) => change.number),
          verification: await loadReleaseVerificationSummary(`${owner}/${repo}`, pr.number, current),
        };
      }),
    );
    return NextResponse.json({ candidates }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[GET /api/repositories/release/candidates] ${owner}/${repo}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
