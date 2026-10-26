import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import type { CheckUserReason } from "@/lib/github/approval-labels";
import { fetchPullRequestRollups, MERGE_JUDGEMENT_UNKNOWN, pullRequestRollupKey } from "@/lib/github/check-rollup";
import type { IosPrecheckSummary } from "@/lib/github/ios-precheck";
import { mapComment } from "@/lib/github/issue-mapper";
import { fetchCommentsForIssue, fetchIssueTimeline } from "@/lib/github/issues-api";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { buildPullRequestEvents } from "@/lib/github/pull-request-events";
import { findCurrentFixRequest, findInterruptedFixRequest } from "@/lib/github/pull-request-fix-request-service";
import { repairKindsFor } from "@/lib/github/pull-request-repair";
import {
  fetchActivePullRequestRepairRun,
  visibleRepairRun,
} from "@/lib/github/pull-request-repair-run";
import { needsReviewAttention, parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { toPullRequestSummary } from "@/lib/github/pull-request-summary";
import {
  fetchPullRequest,
  fetchPullRequestReviewComments,
  fetchPullRequestReviews,
} from "@/lib/github/pull-requests-api";
import { fetchRefCheckState } from "@/lib/github/release-api";
import { fetchRepairWorkflowAvailability } from "@/lib/github/repair-workflow-cache";
import { fetchUnmetRequiredChecks } from "@/lib/github/required-checks";
import { checkUserIssueKey, fetchCheckUserIssueReasons } from "@/lib/pull-request-check-user";
import { resolveMergeCheckReasons, type MergeCheckReasons } from "@/lib/merge-check-reasons";
import { extractLinkedIssueNumber, requiresUserMerge } from "@/lib/pull-request-list";
import {
  resolveStopCause,
  shouldResolveStopCause,
  type PullRequestStopCause,
  type StopCauseTimelineEvent,
} from "@/lib/pull-request-stop-cause";
import type { PullRequestDetail, PullRequestReviewResponseContext } from "@/types/pull-request";

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
    // iOS事前検証（#4882）も同じ条件で並行して引く（Issue詳細の対応PRと同じ。#4140）。
    // 取得に失敗しても詳細全体は落とさず、「記録なし」として出す（成功とは推測しない）。
    const checkable = pullRequest.state === "open" && !pullRequest.draft;
    const [{ ciState, mergeJudgement }, iosPrecheck] = await Promise.all([
      checkable
        ? fetchRefCheckState(owner, repo, pullRequest.head.sha, token)
        : { ciState: "unknown" as const, mergeJudgement: MERGE_JUDGEMENT_UNKNOWN },
      checkable ? fetchIosPrecheck(owner, repo, number, token) : null,
    ]);

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
          baseRef: pullRequest.base.ref,
          headRef: pullRequest.head.ref,
          reviewVerdict: parsePullRequestReviewVerdict(pullRequest.body),
        },
        pullRequest.mergeable,
      ),
      token,
    );

    // いま走っている自動修復（#2072）。GitHub APIは消費せず、DBを1件引くだけ。
    // 症状（コンフリクト・CI失敗）が消えていれば、終了の報告が届いていなくても出さない（#2165）。
    const repairRun = visibleRepairRun(
      await fetchActivePullRequestRepairRun(repository.fullName, number),
      { mergeable: pullRequest.mergeable, ciState },
    );

    // GitHubがマージを止めている（`blocked`）ときだけ、必須チェックの未成功を引く（#4884）。
    // CI状態はios-precheckのような必須のcommit statusを数えないため、緑のまま押すと405になる。
    const unmetRequiredChecks =
      pullRequest.state === "open" && !pullRequest.draft && pullRequest.mergeable_state === "blocked"
        ? await fetchUnmetRequiredChecks(owner, repo, pullRequest.base.ref, pullRequest.head.sha, token)
        : undefined;

    const summary = toPullRequestSummary(
        pullRequest,
        { fullName: repository.fullName, private: repository.private },
        {
          merged: pullRequest.merged,
          ciState,
          mergeJudgement,
          // 詳細は単体取得（`fetchPullRequest`）のレスポンスに`mergeable`を含むため、
          // 一覧のようにGraphQLで取り直す必要はない（#1742）。
          mergeable: pullRequest.mergeable,
          mergeableState: pullRequest.mergeable_state,
          unmetRequiredChecks,
          linkedIssueCheckUser: checkUserKey !== null && checkUserReasons.has(checkUserKey),
          linkedIssueCheckReason:
            checkUserKey === null ? null : (checkUserReasons.get(checkUserKey) ?? null),
          repairWorkflowAvailability,
          repairRun,
        },
      );
    summary.iosPrecheck = iosPrecheck;

    // ユーザーのマージが必要な理由（#4088）。必要なPRでだけ、対応Issueのコメントを1回読む。
    let userMergeReasons: MergeCheckReasons | null = null;
    if (requiresUserMerge(summary)) {
      userMergeReasons = await resolveUserMergeReasons({
        kind: summary.kind,
        repositoryId: repository.id,
        owner,
        repo,
        linkedIssueNumber,
        token,
      });
    }

    // レビュー指摘への対応パネル（#4482）。要修正・要確認が付いたopenなPRでだけ、
    // 紐づくIssueの「現在のHEADへの修正依頼」と、ローカル対応中（11.local）かを引く。
    let reviewResponse: PullRequestReviewResponseContext | null = null;
    if (
      summary.state === "open" &&
      !summary.merged &&
      linkedIssueNumber !== null &&
      summary.reviewVerdict &&
      needsReviewAttention(summary.reviewVerdict.reviewKind)
    ) {
      reviewResponse = await resolveReviewResponseContext({
        repositoryId: repository.id,
        owner,
        repo,
        issueNumber: linkedIssueNumber,
        headSha: pullRequest.head.sha,
        token,
      });
    }

    // 対応Issueの`00.check-user`で止まっているときの直接原因（#5080）。対象のPRでだけtimelineを1回読む
    const stopCause =
      linkedIssueNumber !== null && shouldResolveStopCause(summary)
        ? await resolvePullRequestStopCause({
            owner,
            repo,
            issueNumber: linkedIssueNumber,
            checkReason: summary.linkedIssueCheckReason,
            judgement: summary.mergeJudgement.autoMergeRun ?? null,
            token,
          })
        : null;

    const detail: PullRequestDetail = {
      id: `${repository.fullName}#${number}`,
      summary,
      body: pullRequest.body ?? "",
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changed_files,
      commits: pullRequest.commits,
      events: buildPullRequestEvents({ comments, reviews, reviewComments }),
      fetchedAt: new Date().toISOString(),
      userMergeReasons,
      reviewResponse,
      stopCause,
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

/** PR1件のiOS事前検証の要約。取得できなければnull（記録なしと同じ扱い） */
async function fetchIosPrecheck(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<IosPrecheckSummary | null> {
  try {
    const rollups = await fetchPullRequestRollups([{ owner, repo, number }], token, { includeIosPrecheck: true });
    return rollups.get(pullRequestRollupKey(owner, repo, number))?.iosPrecheck ?? null;
  } catch (error) {
    console.warn(`[GET /api/pull-requests/detail] iOS事前検証を取得できませんでした ${owner}/${repo}#${number}:`, error);
    return null;
  }
}

/**
 * 対応パネルが「依頼済み」「依頼できない」を押す前に出すための材料（#4482）。
 * 11.local・closedはDBのIssueキャッシュから読み（GitHub APIを消費しない）、依頼コメントはIssueの
 * コメントを1回読む。**読めなければ`fetchFailed`にする**——依頼済みを見落として二重に送るより、
 * 「確認できなかった」と出して送信側（同じ依頼は重複として返る）に任せる。
 */
async function resolveReviewResponseContext(params: {
  repositoryId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  headSha: string;
  token: string;
}): Promise<PullRequestReviewResponseContext> {
  const issue = await db.issue
    .findFirst({
      where: { repositoryId: params.repositoryId, number: params.issueNumber },
      select: { state: true, labels: { where: { name: "11.local" }, select: { name: true } } },
    })
    .catch(() => null);
  const local = (issue?.labels.length ?? 0) > 0;
  const closed = issue?.state === "CLOSED";
  try {
    const comments = await fetchCommentsForIssue(params.owner, params.repo, params.issueNumber, params.token);
    return {
      issueNumber: params.issueNumber,
      linkedIssueLocal: local,
      linkedIssueClosed: closed,
      currentFixRequest: findCurrentFixRequest(comments, params.headSha),
      interruptedFixRequest: findInterruptedFixRequest(comments, params.headSha),
      fetchFailed: false,
    };
  } catch (error) {
    console.error(`[GET /api/pull-requests/detail] fix-request lookup ${params.owner}/${params.repo}#${params.issueNumber}:`, error);
    return {
      issueNumber: params.issueNumber,
      linkedIssueLocal: local,
      linkedIssueClosed: closed,
      currentFixRequest: null,
      interruptedFixRequest: null,
      fetchFailed: true,
    };
  }
}

/**
 * 止まった原因を対応Issueのtimelineから決める（#5080）。**読めなければ`fetch-failed`にする**——
 * 取れなかったことを「原因なし」や推測で埋めない。timelineの最後が`00.check-user`の解除なら、
 * キャッシュより新しい情報としてラベルは外れていると読み、nullを返す（カードを出さない）。
 */
async function resolvePullRequestStopCause(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  checkReason: CheckUserReason | null;
  judgement: PullRequestStopCause["judgement"];
  token: string;
}): Promise<PullRequestStopCause | null> {
  const base = {
    issueNumber: params.issueNumber,
    issueUrl: `https://github.com/${params.owner}/${params.repo}/issues/${params.issueNumber}`,
    judgement: params.judgement,
  };
  try {
    const timeline = await fetchIssueTimeline<StopCauseTimelineEvent>(
      params.owner,
      params.repo,
      params.issueNumber,
      params.token,
    );
    const resolved = resolveStopCause({ timeline, checkReason: params.checkReason });
    return resolved === null ? null : { ...base, ...resolved };
  } catch (error) {
    console.error(`[GET /api/pull-requests/detail] stop-cause lookup ${params.owner}/${params.repo}#${params.issueNumber}:`, error);
    return {
      ...base,
      labeledAt: null,
      cause: { status: "unidentified", why: "fetch-failed", investigate: [] },
    };
  }
}

/** リリースPR（develop→main）はIssueの判定と無関係に、常にユーザーがマージする */
const RELEASE_MERGE_REASON: MergeCheckReasons = {
  source: "label",
  items: ["develop→mainのリリースPRは、自動マージ不可カテゴリとして常にユーザーがマージします"],
  postedAtLabel: null,
};

async function resolveUserMergeReasons(params: {
  kind: string;
  repositoryId: string;
  owner: string;
  repo: string;
  linkedIssueNumber: number | null;
  token: string;
}): Promise<MergeCheckReasons> {
  if (params.kind === "release") return RELEASE_MERGE_REASON;
  if (params.linkedIssueNumber === null) return resolveMergeCheckReasons([], []);
  const [issue, rawComments] = await Promise.all([
    db.issue.findFirst({
      where: { repositoryId: params.repositoryId, number: params.linkedIssueNumber },
      select: { labels: { select: { name: true } } },
    }),
    fetchCommentsForIssue(params.owner, params.repo, params.linkedIssueNumber, params.token),
  ]);
  const labels = (issue?.labels ?? []).map((label) => ({ name: label.name, color: "", description: null }));
  return resolveMergeCheckReasons(labels, rawComments.map(mapComment));
}
