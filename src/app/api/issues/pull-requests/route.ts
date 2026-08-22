import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { MERGE_JUDGEMENT_UNKNOWN, pullRequestRollupKey } from "@/lib/github/check-rollup";
import { GithubApiError } from "@/lib/github/issues-api";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { toPullRequestCiStatus } from "@/lib/github/pull-request-ci";
import {
  fetchActivePullRequestRepairRuns,
  repairRunKey,
} from "@/lib/github/pull-request-repair-run";
import {
  fetchPullRequest,
  type GithubApiPullRequestDetail,
} from "@/lib/github/pull-requests-api";
import {
  fetchPullRequestCiStates,
  UNKNOWN_PULL_REQUEST_CI_STATE,
  type PullRequestCiState,
} from "@/lib/github/release-api";
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

/** チェックの結果を見に行く対象か。closedやdraftではマージの判断に使わないので取りに行かない */
function needsCheckState(pullRequest: GithubApiPullRequestDetail): boolean {
  return pullRequest.state === "open" && !pullRequest.draft;
}

function toIssuePullRequest(
  pullRequest: GithubApiPullRequestDetail,
  checkState: PullRequestCiState | null,
  repairRun: IssuePullRequest["repairRun"],
): IssuePullRequest {
  return {
    number: pullRequest.number,
    htmlUrl: pullRequest.html_url,
    title: pullRequest.title,
    state: pullRequest.state === "closed" ? "closed" : "open",
    draft: pullRequest.draft,
    merged: pullRequest.merged,
    ciStatus: checkState ? toPullRequestCiStatus(checkState.ciState) : null,
    mergeJudgement: checkState?.mergeJudgement ?? MERGE_JUDGEMENT_UNKNOWN,
    mergeable: checkState?.mergeable ?? null,
    repairRun,
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
 * **返す状態はPR画面（`/api/pull-requests`）と揃える**（#2145）。CI状態だけを返していた頃は、
 * コンフリクトしているPRや自動修復が走っているPRでもIssue画面には「CI通過」しか出ず、
 * 同じPRを見ているのに画面によって言うことが違っていた。コンフリクト有無（`mergeable`）は
 * CI状態と同じ1回のGraphQLに相乗りし、修復状況（`repairRun`）はDBを1回引くだけなので、
 * どちらもGitHub APIの消費を増やさない。
 *
 * 消費するのはPR1件あたり1リクエスト（REST）に、openかつdraftでないPRがあれば
 * **件数によらず1回**のGraphQL（`fetchPullRequestCiStates`）を足したぶん。PR1件ずつ
 * チェックを引いていた頃より減っている。
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
    const fetched = await Promise.all(
      numbers.map(async (number) => {
        try {
          return await fetchPullRequest(owner, repo, number, token);
        } catch (error) {
          if (error instanceof GithubApiError && error.status === 404) return null;
          throw error;
        }
      }),
    );
    const pullRequests = fetched.filter((pr): pr is GithubApiPullRequestDetail => pr !== null);
    const targets = pullRequests.filter(needsCheckState);

    // CI状態・コンフリクト有無・判定の進み具合は、対象PRをまとめて1回のGraphQLで引く（#1962と
    // 同じ形）。取得できなかったPRはキーごと落ちるので、未取得（`unknown` / `null`）へ縮退させる。
    const checkStates =
      targets.length === 0
        ? new Map<string, PullRequestCiState>()
        : await fetchPullRequestCiStates(
            targets.map((pullRequest) => ({ owner, repo, number: pullRequest.number })),
            token,
          );
    // いま走っている自動修復（#2072）はGitHubからは引けない。DBを1回引くだけで足りる。
    const repairRuns = await fetchActivePullRequestRepairRuns(
      targets.map((pullRequest) => ({
        repositoryFullName: repository.fullName,
        pullRequestNumber: pullRequest.number,
      })),
    );

    const response: IssuePullRequestListResponse = {
      pullRequests: pullRequests.map((pullRequest) =>
        toIssuePullRequest(
          pullRequest,
          needsCheckState(pullRequest)
            ? (checkStates.get(pullRequestRollupKey(owner, repo, pullRequest.number)) ??
              UNKNOWN_PULL_REQUEST_CI_STATE)
            : null,
          repairRuns.get(repairRunKey(repository.fullName, pullRequest.number)) ?? null,
        ),
      ),
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
