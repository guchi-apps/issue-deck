import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { fetchPullRequest } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import type { GithubApiPullRequest } from "@/lib/github/release-api";
import { getIssueForUser } from "@/lib/issues-for-user";
import { previewModeGuard } from "@/lib/preview-mode";
import {
  decideReleaseFixStart,
  parseReleaseFixStatus,
  RELEASE_FIX_CAUSE_CLASSES,
  RELEASE_FIX_SOURCE_KINDS,
  type ReleaseFixCauseClass,
  type ReleaseFixSourceKind,
} from "@/lib/release-fix-series";
import {
  acceptReleaseFixExtraPullRequests,
  createReleaseFixSeries,
  listReleaseFixSeries,
  readReleaseFixStartState,
} from "@/lib/release-fix-series-run";
import { isReleasePullRequest } from "@/lib/release-merge-gate";
import { loadReleaseVerificationSummary } from "@/lib/release-verification-load";

/**
 * リリース候補の修正系列（#4317）。
 *
 * - GET: このリリースPRに関わる系列（起案済みの修正Issue・修正PR・後継候補・現在地・停止理由）
 * - GET `startCheck=<系列ID>`: 「修正を開始」の前にサーバーが対象を確かめ、起動ダイアログへ渡すIssueを返す（#4396）
 * - POST `action=create`: 全体レビューの指摘・統合検証の失敗から修正Issueを起案する。**対象は現在のSHAの結果だけ**
 *   （サーバーが記録から読み直し、クライアントの内容を信用しない）。同じ対象は既存の系列を返す
 * - POST `action=accept_extra`: 修正と無関係なdevelopの変更を含めて作り直すことを確認する
 */

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: { fullName: `${owner}/${repo}`, installation: { userInstallations: { some: { userId } } } },
    include: { installation: true },
  });
}

export function GET(request: NextRequest) {
  return withGithubApiFeature("release_status", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const startCheck = searchParams.get("startCheck");
  if (startCheck) return handleStartCheck(userId, owner, repo, startCheck);
  const number = Number(searchParams.get("pullRequest"));
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!(await findRepository(userId, owner, repo))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const series = await listReleaseFixSeries(`${owner}/${repo}`, number);
  return NextResponse.json({ series }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * 「修正を開始」を押す前の確認（#4396）。**起動の前にサーバーが対象を確かめる**: 系列がこのリポジトリのもので、
 * ユーザーが見えるリポジトリであり、後継の世代に置き換わっておらず、Issueが開いていて未開始のときだけ、
 * 起動ダイアログに渡すIssueを返す。実際の起動（権限・ホスト・確認待ち・重複ジョブの防止）は既存の配車APIが行う。
 */
async function handleStartCheck(userId: string, owner: string | null, repo: string | null, seriesId: string) {
  if (!owner || !repo) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  if (!(await findRepository(userId, owner, repo))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const repositoryFullName = `${owner}/${repo}`;
  const row = await db.releaseFixSeries.findFirst({ where: { id: seriesId, repositoryFullName } });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const issue = await getIssueForUser(userId, repositoryFullName, row.issueNumber);
  if (!issue) return NextResponse.json({ error: "issue_not_synced", message: "修正Issueがまだ一覧に取り込まれていません。少し待ってから再度押してください。" }, { status: 409 });
  const [successor, startState] = await Promise.all([
    db.releaseFixSeries.findFirst({ where: { parentId: row.id }, select: { id: true } }),
    readReleaseFixStartState(repositoryFullName, row.issueNumber),
  ]);
  const decision = decideReleaseFixStart({
    status: parseReleaseFixStatus(row.status) ?? "stopped",
    hasSuccessor: successor !== null,
    issueState: issue.state === "closed" ? "closed" : "open",
    startState,
  });
  if (!decision.ok) return NextResponse.json({ error: decision.reason, message: decision.message, issue: decision.reason === "already_started" ? issue : undefined }, { status: 409, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ ok: true, issue }, { headers: { "Cache-Control": "no-store" } });
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("release_status", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  if (typeof owner !== "string" || typeof repo !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const repository = await findRepository(userId, owner, repo);
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (payload.action === "accept_extra") {
    const seriesId = payload.seriesId;
    if (typeof seriesId !== "string") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const owned = await db.releaseFixSeries.findFirst({ where: { id: seriesId, repositoryFullName: `${owner}/${repo}` } });
    if (!owned) return NextResponse.json({ error: "not_found" }, { status: 404 });
    try {
      const result = await acceptReleaseFixExtraPullRequests(seriesId, userId);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
      return NextResponse.json({ ok: true });
    } catch (error) {
      console.error("[POST /api/repositories/release/fix-series accept_extra]", error);
      return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
    }
  }

  if (payload.action !== "create") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const pullRequestNumber = payload.pullRequestNumber;
  const sourceKind: ReleaseFixSourceKind | undefined = RELEASE_FIX_SOURCE_KINDS.find((k) => k === payload.sourceKind);
  const causeClass: ReleaseFixCauseClass = RELEASE_FIX_CAUSE_CLASSES.find((c) => c === payload.causeClass) ?? "code";
  const findingIndexes: number[] = Array.isArray(payload.findingIndexes)
    ? payload.findingIndexes.filter((n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0)
    : [];
  const decisionQuestion =
    typeof payload.decisionQuestion === "string" && payload.decisionQuestion.trim() !== ""
      ? payload.decisionQuestion.trim().slice(0, 2000)
      : null;
  if (typeof pullRequestNumber !== "number" || !sourceKind) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (causeClass === "decision" && !decisionQuestion) {
    return NextResponse.json({ error: "decision_question_required" }, { status: 400 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const pr = (await fetchPullRequest(owner, repo, pullRequestNumber, token)) as GithubApiPullRequest & { state?: string };
    if (!pr.base || !isReleasePullRequest({ baseRef: pr.base.ref, headRef: pr.head.ref })) {
      return NextResponse.json({ error: "not_release_pull_request" }, { status: 404 });
    }
    if (pr.state !== "open") return NextResponse.json({ error: "release_pr_changed" }, { status: 409 });
    // 画面で見ていたSHAと今の候補が違えば、古い指摘から起案しない
    if (
      (typeof payload.baseSha === "string" && payload.baseSha !== pr.base.sha) ||
      (typeof payload.headSha === "string" && payload.headSha !== pr.head.sha)
    ) {
      return NextResponse.json({ error: "release_pr_changed" }, { status: 409 });
    }
    const summary = await loadReleaseVerificationSummary(`${owner}/${repo}`, pullRequestNumber, {
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
    });
    const result = await createReleaseFixSeries({
      userId,
      owner,
      repo,
      token,
      releasePr: pr,
      sourceKind,
      findingIndexes,
      causeClass,
      decisionQuestion,
      acknowledgeExecutionFailure: payload.acknowledgeExecutionFailure === true,
      section: sourceKind === "review_finding" ? summary.aiReview : summary.integration,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
    });
    if ("series" in result) {
      return NextResponse.json({ outcome: result.outcome, series: result.series });
    }
    const status = result.outcome === "no_items" ? 400 : 409;
    return NextResponse.json({ error: result.outcome, message: result.message }, { status });
  } catch (error) {
    console.error("[POST /api/repositories/release/fix-series create]", error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
