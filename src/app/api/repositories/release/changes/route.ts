import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import {
  fetchClosedPullRequestsForBase,
  fetchCompareCommits,
  fetchPullRequest,
  fetchPullRequestCommits,
  PULL_REQUEST_COMMITS_PER_PAGE,
} from "@/lib/github/pull-requests-api";
import { fetchPullRequestRollups, pullRequestRollupKey } from "@/lib/github/check-rollup";
import {
  toReleaseChanges,
  toReleaseChangeCi,
  withFixedBy,
  withMergeChecks,
  withReleaseReviews,
  type ReleaseFixSeriesRow,
} from "@/lib/release-changes";
import type {
  ReleaseChangeCiCheck,
  ReleaseChangeListResponse,
  ReleaseChangePullRequest,
} from "@/types/pull-request";

/** closed一覧に無いPRの本文を単体で補う上限。超えた分は「取得できませんでした」にする */
const MAX_BODY_FETCHES = 20;

/**
 * 各PRの本文（`## 検証結果`の節を持つ）を集める。まずdevelop向けのclosed一覧を1回で引き
 * （ETagで条件付きGET）、足りないPRだけ単体取得で補う。取れなかったPRは結果に入れない。
 */
async function fetchPullRequestBodies(
  owner: string,
  repo: string,
  numbers: readonly number[],
  token: string,
): Promise<Map<number, { body: string | null; headSha: string }>> {
  const bodies = new Map<number, { body: string | null; headSha: string }>();
  if (numbers.length === 0) return bodies;
  const wanted = new Set(numbers);
  try {
    for (const pr of await fetchClosedPullRequestsForBase(owner, repo, "develop", token)) {
      if (wanted.has(pr.number)) bodies.set(pr.number, { body: pr.body, headSha: pr.head.sha });
    }
  } catch (error) {
    // 一覧が取れなくても、単体取得で補えるぶんは補う
    console.error(`[release/changes] closed一覧を取得できませんでした ${owner}/${repo}:`, error);
  }
  const missing = numbers.filter((n) => !bodies.has(n)).slice(0, MAX_BODY_FETCHES);
  await Promise.all(
    missing.map(async (n) => {
      try {
        const pr = await fetchPullRequest(owner, repo, n, token);
        bodies.set(n, { body: pr.body, headSha: pr.head.sha });
      } catch {
        // 入れない＝取得不可として画面に出る
      }
    }),
  );
  return bodies;
}

/** 一覧のPRを修正PRに持つ修正系列を引く（#5175）。`items[].pullRequests`を平らにして渡す */
async function fetchFixSeriesRows(repositoryFullName: string, fixPrCandidates: readonly number[]): Promise<ReleaseFixSeriesRow[]> {
  if (fixPrCandidates.length === 0) return [];
  const rows = await db.releaseFixSeries.findMany({
    where: { repositoryFullName, fixPrNumber: { in: [...fixPrCandidates] }, fixPrMergedAt: { not: null } },
    select: { status: true, sourceKind: true, issueNumber: true, fixPrNumber: true, fixPrMergedAt: true, items: true },
  });
  return rows.map((row) => ({
    status: row.status,
    sourceKind: row.sourceKind,
    issueNumber: row.issueNumber,
    fixPrNumber: row.fixPrNumber,
    fixPrMergedAt: row.fixPrMergedAt,
    relatedPullRequests: relatedPullRequestsOf(row.items),
  }));
}

function relatedPullRequestsOf(items: unknown): number[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    const list = (item as { pullRequests?: unknown } | null)?.pullRequests;
    return Array.isArray(list) ? list.filter((n): n is number => Number.isInteger(n)) : [];
  });
}

/**
 * 6チェック（#4305・#4366）の追加取得。**`include=merge-checks`を付けた呼び出し（本番マージ確認ダイアログ）
 * だけが呼ぶ**——この応答は他の画面も使うので、全員にGitHubの呼び出しを増やさない。
 * CIはPRのhead（個別PRの過去の結果）をGraphQL1本でまとめて引く。計画レビューはPRのチェックに含めない。失敗したPRは結果に入れない（`withMergeChecks`が取得不可にする）。
 */
async function fetchMergeChecks(
  owner: string,
  repo: string,
  pullRequests: readonly ReleaseChangePullRequest[],
  token: string,
): Promise<{ ci: Map<number, ReleaseChangeCiCheck> }> {
  const targets = pullRequests.filter((pr) => !pr.isVersionBump);
  const ci = new Map<number, ReleaseChangeCiCheck>();

  const rollups = await fetchPullRequestRollups(
    targets.map((pr) => ({ owner, repo, number: pr.number })),
    token,
  ).catch(() => new Map());
  for (const pr of targets) {
    const rollup = rollups.get(pullRequestRollupKey(owner, repo, pr.number));
    if (rollup) ci.set(pr.number, toReleaseChangeCi(rollup.rollup?.state));
  }

  return { ci };
}

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
  const includeMergeChecks = searchParams.get("include") === "merge-checks";
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
    const bodies = await fetchPullRequestBodies(
      owner,
      repo,
      pullRequests.filter((pr) => !pr.isVersionBump).map((pr) => pr.number),
      token,
    );
    const reviewed = withFixedBy(
      withReleaseReviews(pullRequests, bodies),
      await fetchFixSeriesRows(`${owner}/${repo}`, pullRequests.map((pr) => pr.number)).catch(() => []),
    );
    let withChecks = reviewed;
    if (includeMergeChecks) {
      const checks = await fetchMergeChecks(owner, repo, reviewed, token);
      withChecks = withMergeChecks(reviewed, checks.ci);
    }
    const response: ReleaseChangeListResponse = {
      pullRequests: withChecks,
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
