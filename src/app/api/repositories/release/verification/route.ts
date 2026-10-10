import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { fetchPullRequest } from "@/lib/github/actions-api";
import { isReleasePullRequest } from "@/lib/release-merge-gate";
import { loadReleaseVerificationSummary } from "@/lib/release-verification-load";

/**
 * リリースPRの統合検証・全体AIレビューの状態（#4238）。PCのリリースPR詳細が使う軽い取得で、
 * GitHubへはPR1件の取得だけ（スマホのシートは`GET /api/repositories/release`が同じ要約を返す）。
 * リリースPR（base=main・head=`release-main/v*`）以外は404。
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
  const number = Number(searchParams.get("pullRequest"));
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await db.repository.findFirst({
    where: { fullName: `${owner}/${repo}`, installation: { userInstallations: { some: { userId } } } },
    include: { installation: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const pr = await fetchPullRequest(owner, repo, number, token);
    if (!pr.base || !pr.head.ref || !isReleasePullRequest({ baseRef: pr.base.ref, headRef: pr.head.ref })) {
      return NextResponse.json({ error: "not_release_pull_request" }, { status: 404 });
    }
    const verification = await loadReleaseVerificationSummary(`${owner}/${repo}`, number, {
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
    });
    return NextResponse.json({ verification, headRef: pr.head.ref }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[GET /api/repositories/release/verification] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
