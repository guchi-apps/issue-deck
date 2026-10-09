import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import {
  fetchCompareCommits,
  fetchPullRequestCommits,
  PULL_REQUEST_COMMITS_PER_PAGE,
} from "@/lib/github/pull-requests-api";
import { toReleaseChanges } from "@/lib/release-changes";
import type { ReleaseChangeListResponse } from "@/types/pull-request";

export function GET(request: NextRequest) {
  return withGithubApiFeature("release_changes", () => handleGET(request));
}

/**
 * リリース起動確認の「今回反映する内容」を、PR単位で返す（#4201）。
 *
 * 範囲は実際にmainへ入る差分から求める。
 * - 既定は`main...develop`の差分。Issueの状態や進捗は見ない
 * - `pullRequest`を渡すと、作成済みのリリースPRのコミットを使う。リリースPRは作成時点で
 *   内容が凍結されるので、**その後にdevelopへ入った変更を含めて表示しない**
 *
 * 起動確認ダイアログを開いたときだけ呼ぶ。GitHubの取得に失敗したら502を返す
 * （空の一覧を返すと、取得失敗が「変更0件」に見えてしまう）。
 */
async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const pullRequestParam = searchParams.get("pullRequest");
  const pullRequestNumber = pullRequestParam === null ? null : Number(pullRequestParam);

  if (
    !owner ||
    !repo ||
    (pullRequestNumber !== null && (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0))
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    let commits;
    let totalCommits: number;
    if (pullRequestNumber !== null) {
      commits = await fetchPullRequestCommits(owner, repo, pullRequestNumber, token);
      totalCommits = commits.length;
    } else {
      ({ commits, totalCommits } = await fetchCompareCommits(owner, repo, "main", "develop", token));
    }

    const truncated =
      totalCommits > commits.length || commits.length >= PULL_REQUEST_COMMITS_PER_PAGE;
    const { pullRequests, unknownCommits } = toReleaseChanges(
      commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message })),
    );
    const response: ReleaseChangeListResponse = {
      pullRequests,
      unknownCommits,
      source: pullRequestNumber !== null ? "release-pr" : "develop",
      // 打ち切ったときは末尾が終端とは限らないので出さない
      headSha: !truncated && commits.length > 0 ? commits[commits.length - 1].sha.slice(0, 7) : null,
      truncated,
    };
    return NextResponse.json(response);
  } catch (error) {
    console.error(`[GET /api/repositories/release/changes] ${owner}/${repo}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: githubApiErrorMessage(error) },
      { status: 502 },
    );
  }
}
