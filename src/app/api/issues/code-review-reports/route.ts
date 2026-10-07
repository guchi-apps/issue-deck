import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { expireStaleDispatchJobs } from "@/lib/dispatch/jobs";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  resolveCodeReviewRunStatus,
  summarizeCodeReviewComments,
  type CodeReviewRunJob,
  type CodeReviewSummary,
} from "@/lib/github/code-review";
import {
  codeReviewSummaryCacheKey,
  getCodeReviewSummaryCache,
  setCodeReviewSummaryCache,
} from "@/lib/github/code-review-report-cache";
import { fetchCommentsForIssue } from "@/lib/github/issues-api";

/**
 * 「コードレビュー」ビューの一覧に出す、レビュー結果の要約（#2855）。
 *
 * **一覧に並んでいるレビューIssueをまとめて受け、要約だけを返す。** 結果はIssueコメントに
 * しか無いのでIssue1件につきコメント一覧を1回取ることになるが、並ぶのはレビューIssueだけで
 * （ふつう数件）、コメント件数が変わらない間はプロセス内キャッシュから返す
 * （`code-review-report-cache.ts`）。**ポーリングはしない**——一覧を開いたときに1回だけ引く。
 *
 * 指摘の本文は返さない。中身を読むのは今までどおりIssue詳細の`CodeReviewPanel`で、
 * ここは行のバッジ（重大n・中n・軽微n／レビュー中／指摘なし）のための口。
 *
 * **実行の状態（#4116）も返す。** 各レビューIssueの最新の`DispatchJob`（`kind=CODE_REVIEW`）を
 * DBから引き、コメントの要約と合わせて`runStatus`を決める（`resolveCodeReviewRunStatus`）。
 * ジョブはキャッシュしない（状態は数十秒で動き、引くのはDBだけなのでGitHubは叩かない）。
 * Issue詳細も同じ口を使ってジョブを受け取り、手元のコメントと同じ関数で状態を決める。
 */

/** 1回で受け付けるレビューIssueの上限。取りこぼした分は行のバッジが出ないだけで済む */
const MAX_ISSUES = 30;

type RequestedIssue = { key: string; owner: string; repo: string; number: number };

/** `owner/repo#123`をほどく。形が違うものは黙って捨てる（画面が組み立てる値なので起きない） */
function parseIssueKey(value: string): RequestedIssue | null {
  const matched = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/.exec(value.trim());
  if (!matched) return null;
  const number = Number(matched[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { key: value.trim(), owner: matched[1], repo: matched[2], number };
}

export function GET(request: NextRequest) {
  return withGithubApiFeature("code_review_summary", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get("issues") ?? "")
    .split(",")
    .map(parseIssueKey)
    .filter((issue): issue is RequestedIssue => issue !== null)
    .slice(0, MAX_ISSUES);

  if (requested.length === 0) {
    return NextResponse.json({ summaries: [] });
  }

  // リポジトリとIssueはそれぞれ1本で引く。Issueごとに引くとN+1になる
  const repositories = await db.repository.findMany({
    where: {
      fullName: { in: [...new Set(requested.map((issue) => `${issue.owner}/${issue.repo}`))] },
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
  const repositoryByFullName = new Map(repositories.map((row) => [row.fullName, row]));

  const numbersByRepositoryId = new Map<string, number[]>();
  for (const issue of requested) {
    const repository = repositoryByFullName.get(`${issue.owner}/${issue.repo}`);
    if (!repository) continue;
    const numbers = numbersByRepositoryId.get(repository.id);
    if (numbers) numbers.push(issue.number);
    else numbersByRepositoryId.set(repository.id, [issue.number]);
  }

  const issueRows =
    numbersByRepositoryId.size === 0
      ? []
      : await db.issue.findMany({
          where: {
            OR: [...numbersByRepositoryId].map(([repositoryId, numbers]) => ({
              repositoryId,
              number: { in: numbers },
            })),
          },
          select: { number: true, commentCount: true, repositoryId: true },
        });
  const commentCountByKey = new Map(
    issueRows.map((row) => [`${row.repositoryId}#${row.number}`, row.commentCount]),
  );

  // 生存報告が途絶えた実行（プロセス消失・ホスト停止）を、画面を開いた時点で確定させる。
  // 普段は`GET /api/dispatch`のポーリングが掃いているが、この口だけを見ている画面もある
  await expireStaleDispatchJobs().catch((error) => {
    console.error("[GET /api/issues/code-review-reports] 期限切れジョブの掃除に失敗しました:", error);
  });
  const jobRows = await db.dispatchJob.findMany({
    where: {
      kind: "CODE_REVIEW",
      OR: requested.map((issue) => ({
        repositoryFullName: `${issue.owner}/${issue.repo}`,
        issueNumber: issue.number,
      })),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      repositoryFullName: true,
      issueNumber: true,
      status: true,
      message: true,
      targetHost: true,
      createdAt: true,
      startedAt: true,
      heartbeatAt: true,
      finishedAt: true,
    },
  });
  // 新しい順に並べてあるので、最初に見たものが最新の実行
  const latestJobByKey = new Map<string, CodeReviewRunJob>();
  for (const row of jobRows) {
    const key = `${row.repositoryFullName}#${row.issueNumber}`;
    if (latestJobByKey.has(key)) continue;
    latestJobByKey.set(key, {
      id: row.id,
      status: row.status,
      message: row.message,
      targetHost: row.targetHost,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
    });
  }
  const withRun = (issue: RequestedIssue, summary: CodeReviewSummary) => {
    const job = latestJobByKey.get(`${issue.owner}/${issue.repo}#${issue.number}`) ?? null;
    return { key: issue.key, ...summary, job, runStatus: resolveCodeReviewRunStatus(summary, job) };
  };

  const summaries = await Promise.all(
    requested.map(async (issue) => {
      const repository = repositoryByFullName.get(`${issue.owner}/${issue.repo}`);
      if (!repository) return null;

      // コメント件数はキャッシュの有効性判定にだけ使う。取れない場合（同期前）はキャッシュを使わない
      const commentCount =
        commentCountByKey.get(`${repository.id}#${issue.number}`) ?? null;
      const cacheKey = codeReviewSummaryCacheKey(issue.owner, issue.repo, issue.number);
      const cached =
        commentCount === null ? null : getCodeReviewSummaryCache(cacheKey, commentCount);
      if (cached) return withRun(issue, cached);

      try {
        const token = await getInstallationToken(repository.installation.installationId);
        const comments = await fetchCommentsForIssue(
          issue.owner,
          issue.repo,
          issue.number,
          token,
        );
        const summary: CodeReviewSummary = summarizeCodeReviewComments(
          comments.map((comment) => ({ body: comment.body ?? "" })),
        );
        if (commentCount !== null) {
          setCodeReviewSummaryCache(cacheKey, { summary, commentCount });
        }
        return withRun(issue, summary);
      } catch (error) {
        // 1件取れなくても他の行のバッジは出す。取れなかった行はバッジが出ないだけ
        console.error(
          `[GET /api/issues/code-review-reports] ${issue.owner}/${issue.repo}#${issue.number}:`,
          error,
        );
        return null;
      }
    }),
  );

  return NextResponse.json({ summaries: summaries.filter((summary) => summary !== null) });
}
