import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchCommentsForIssue } from "@/lib/github/issues-api";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { buildPullRequestEvents } from "@/lib/github/pull-request-events";
import { repairKindsFor } from "@/lib/github/pull-request-repair";
import { fetchActivePullRequestRepairRun } from "@/lib/github/pull-request-repair-run";
import { toPullRequestSummary } from "@/lib/github/pull-request-summary";
import {
  fetchPullRequest,
  fetchPullRequestReviewComments,
  fetchPullRequestReviews,
} from "@/lib/github/pull-requests-api";
import { fetchRefCheckState } from "@/lib/github/release-api";
import { fetchRepairWorkflowAvailability } from "@/lib/github/repair-workflow-cache";
import { checkUserIssueKey, fetchCheckUserIssueReasons } from "@/lib/pull-request-check-user";
import { extractLinkedIssueNumber } from "@/lib/pull-request-list";
import type { PullRequestDetail } from "@/types/pull-request";

export function GET(request: NextRequest) {
  return withGithubApiFeature("pull_request_detail", () => handleGET(request));
}

/**
 * PR1件のヘッダー情報・本文・コメントを取得する。一覧（`/api/pull-requests`）と同じく
 * キャッシュせず都度GitHub APIから読む。1回で4リクエスト（PR本体・会話コメント・レビュー・
 * レビューコメント）、openなPRではCI状態を足して5リクエストを消費するため、呼ぶのは
 * ユーザーがPRを選んだ・画面内のリンクからPRを開いたときだけ（ポーリングはしない）。
 *
 * 一覧に載っていないPR（マージ済み・クローズ済み）も画面内のリンクから開けるようにしたため
 * （#1260）、ヘッダー表示用の`summary`もあわせて返す。
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
    const [pullRequest, comments, reviews, reviewComments] = await Promise.all([
      fetchPullRequest(owner, repo, number, token),
      // PRの会話コメントはissueコメントと同じエンドポイントで取れる（GitHubではPRもissue）。
      fetchCommentsForIssue(owner, repo, number, token),
      fetchPullRequestReviews(owner, repo, number, token),
      fetchPullRequestReviewComments(owner, repo, number, token),
    ]);

    // CI状態はまだマージ・レビューの判断が要るPRでしか意味を持たない。closedなPRや
    // draftでは追加の1リクエストを使わずunknownのままにする（一覧側と同じ方針）。
    // 自動マージ可否の判定の進み具合（#1968）も同じ1回のクエリから取り出す。
    const { ciState, mergeJudgement } =
      pullRequest.state === "open" && !pullRequest.draft
        ? await fetchRefCheckState(owner, repo, pullRequest.head.sha, token)
        : { ciState: "unknown" as const, mergeJudgement: "unknown" as const };

    // 対応Issueの`00.check-user`と、その理由（#1490）を合流させる（#1469）。GitHub APIは
    // 消費せず、DBキャッシュを1件引くだけ。番号の推定は一覧と同じ純粋関数を通す。
    const linkedIssueNumber = extractLinkedIssueNumber({
      headRef: pullRequest.head.ref,
      title: pullRequest.title,
      body: pullRequest.body,
    });
    const checkUserReasons = await fetchCheckUserIssueReasons(
      linkedIssueNumber === null
        ? []
        : [{ repositoryId: repository.id, issueNumbers: [linkedIssueNumber] }],
    );
    const checkUserKey =
      linkedIssueNumber === null ? null : checkUserIssueKey(repository.id, linkedIssueNumber);

    // 自動修復ワークフローが配られているかは、修復ボタンを出すPRでだけ確かめる（#1960）。
    // 一覧と同じキャッシュを通るので、一覧から開いた直後は追加のAPI消費が無い。
    const repairWorkflowAvailability = await fetchRepairWorkflowAvailability(
      owner,
      repo,
      { number: pullRequest.number, baseRef: pullRequest.base.ref, headRef: pullRequest.head.ref },
      repairKindsFor(
        {
          state: pullRequest.state === "closed" ? "closed" : "open",
          draft: pullRequest.draft,
          ciState,
        },
        pullRequest.mergeable,
      ),
      token,
    );

    // いま走っている自動修復（#2072）。GitHub APIは消費せず、DBを1件引くだけ。
    const repairRun = await fetchActivePullRequestRepairRun(repository.fullName, number);

    const detail: PullRequestDetail = {
      id: `${repository.fullName}#${number}`,
      summary: toPullRequestSummary(
        pullRequest,
        { fullName: repository.fullName, private: repository.private },
        {
          merged: pullRequest.merged,
          ciState,
          mergeJudgement,
          // 詳細は単体取得（`fetchPullRequest`）のレスポンスに`mergeable`を含むため、
          // 一覧のようにGraphQLで取り直す必要はない（#1742）。
          mergeable: pullRequest.mergeable,
          linkedIssueCheckUser: checkUserKey !== null && checkUserReasons.has(checkUserKey),
          linkedIssueCheckReason:
            checkUserKey === null ? null : (checkUserReasons.get(checkUserKey) ?? null),
          repairWorkflowAvailability,
          repairRun,
        },
      ),
      body: pullRequest.body ?? "",
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changed_files,
      commits: pullRequest.commits,
      events: buildPullRequestEvents({ comments, reviews, reviewComments }),
      fetchedAt: new Date().toISOString(),
    };
    return NextResponse.json(detail);
  } catch (error) {
    console.error(`[GET /api/pull-requests/detail] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: githubApiErrorMessage(error) },
      { status: 502 },
    );
  }
}
