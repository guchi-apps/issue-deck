import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import {
  fetchPullRequestCommits,
  PULL_REQUEST_COMMITS_PER_PAGE,
} from "@/lib/github/pull-requests-api";
import { applyIssueTitles, toPullRequestChanges } from "@/lib/pull-request-changes";
import type { PullRequestChangeListResponse } from "@/types/pull-request";

export function GET(request: NextRequest) {
  return withGithubApiFeature("pull_request_changes", () => handleGET(request));
}

/**
 * PR1件に含まれる変更（developへ入ったPRとその対応Issue）を返す（#2080）。
 *
 * **マージ確認ダイアログを開いたときだけ呼ぶ。** 画面はmainへのPR（＝本番デプロイが走るマージ）
 * でしか出さないため、通常のPRを見て回るぶんではGitHub APIを消費しない。
 *
 * 消費するのはGitHub REST 1回（`GET /pulls/{number}/commits`）。ページングはせず
 * `PULL_REQUEST_COMMITS_PER_PAGE`件で打ち切り、打ち切ったことは`truncated`で画面へ伝える。
 * **対応Issueのタイトルはissue-deckが持っているキャッシュ（`Issue`テーブル）から解決する**ので、
 * Issueの件数ぶんの追加リクエストは発生しない。
 */
async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const numberParam = searchParams.get("number");

  if (!owner || !repo || !numberParam || Number.isNaN(Number(numberParam))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const number = Number(numberParam);

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
    const commits = await fetchPullRequestCommits(owner, repo, number, token);
    const changes = toPullRequestChanges(
      commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message })),
    );

    const issueNumbers = changes
      .map((change) => change.issueNumber)
      .filter((issueNumber): issueNumber is number => issueNumber !== null);
    const issues =
      issueNumbers.length === 0
        ? []
        : await db.issue.findMany({
            where: { repositoryId: repository.id, number: { in: issueNumbers } },
            select: { number: true, title: true },
          });
    const titleByIssueNumber = new Map(issues.map((issue) => [issue.number, issue.title]));

    const response: PullRequestChangeListResponse = {
      changes: applyIssueTitles(changes, titleByIssueNumber),
      commitCount: commits.length,
      truncated: commits.length >= PULL_REQUEST_COMMITS_PER_PAGE,
    };
    return NextResponse.json(response);
  } catch (error) {
    console.error(`[GET /api/pull-requests/changes] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: githubApiErrorMessage(error) },
      { status: 502 },
    );
  }
}
