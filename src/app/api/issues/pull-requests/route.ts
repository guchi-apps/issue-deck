import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/issues-api";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { toPullRequestCiStatus } from "@/lib/github/pull-request-ci";
import {
  fetchPullRequest,
  type GithubApiPullRequestDetail,
} from "@/lib/github/pull-requests-api";
import { fetchRefCheckState } from "@/lib/github/release-api";
import { extractLinkedIssueNumber } from "@/lib/pull-request-list";
import type { IssuePullRequest, IssuePullRequestListResponse } from "@/types/pull-request";

/** 1回のリクエストで取得する対応PRの上限。これを超える数のPRが1つのIssueにぶら下がる運用は想定していない */
const MAX_NUMBERS = 10;

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

function parseNumbers(raw: string | null): number[] | null {
  if (!raw) return null;
  const numbers = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(Number);
  if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  return [...new Set(numbers)].slice(0, MAX_NUMBERS);
}

async function toIssuePullRequest(
  owner: string,
  repo: string,
  pullRequest: GithubApiPullRequestDetail,
  token: string,
): Promise<IssuePullRequest> {
  // CI状態はまだマージの判断が要るPRでしか意味を持たない。closedやdraftでは追加の
  // 1リクエストを使わずnullのままにする（`/api/pull-requests/detail`と同じ方針）。
  // 自動マージ可否の判定の進み具合（#1968）も同じ1回のクエリから取り出す。
  const checkState =
    pullRequest.state === "open" && !pullRequest.draft
      ? await fetchRefCheckState(owner, repo, pullRequest.head.sha, token)
      : null;
  const ciStatus = checkState ? toPullRequestCiStatus(checkState.ciState) : null;

  return {
    number: pullRequest.number,
    htmlUrl: pullRequest.html_url,
    title: pullRequest.title,
    state: pullRequest.state === "closed" ? "closed" : "open",
    draft: pullRequest.draft,
    merged: pullRequest.merged,
    ciStatus,
    mergeJudgement: checkState?.mergeJudgement ?? "unknown",
    linkedIssueNumber: extractLinkedIssueNumber({
      headRef: pullRequest.head.ref,
      title: pullRequest.title,
      body: pullRequest.body,
    }),
  };
}

export function GET(request: NextRequest) {
  return withGithubApiFeature("pull_request_ci", () => handleGET(request));
}

/**
 * Issueの対応PRを番号指定でまとめて取得する（#1339）。
 *
 * 対応PRの番号自体はコメント本文のURL（`lib/github/pull-request-link.ts`）またはTimeline APIの
 * cross-reference（`/api/issues/pull-request-link`）から画面側が持っており、ここはその番号から
 * タイトル・状態・CI状態を引く。PR一覧（`/api/pull-requests`）と同じくキャッシュしない。
 *
 * 消費するのはPR1件あたり1リクエスト、openかつdraftでないPRではCI状態を足して2リクエスト。
 * 元々あった`/api/issues/pull-request-ci-status`もPR単体取得＋check-runsで2リクエストを
 * 使っていたため、状態・タイトルを返すようになっても消費は増えていない。
 *
 * 個別のPRの取得失敗（404など）は結果から落とすだけで全体は失敗させない。対応PRの番号は
 * コメント本文の解析で得た推定であり、無関係なURLが混ざっていても画面が壊れないようにするため。
 */
async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const numbers = parseNumbers(searchParams.get("numbers"));

  if (!owner || !repo || !numbers) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const results = await Promise.all(
      numbers.map(async (number) => {
        try {
          const pullRequest = await fetchPullRequest(owner, repo, number, token);
          return await toIssuePullRequest(owner, repo, pullRequest, token);
        } catch (error) {
          if (error instanceof GithubApiError && error.status === 404) return null;
          throw error;
        }
      }),
    );

    const response: IssuePullRequestListResponse = {
      pullRequests: results.filter((pr): pr is IssuePullRequest => pr !== null),
    };
    return NextResponse.json(response);
  } catch (error) {
    console.error(`[GET /api/issues/pull-requests] ${owner}/${repo} ${numbers.join(",")}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: githubApiErrorMessage(error) },
      { status: 502 },
    );
  }
}
