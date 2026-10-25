import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { requestReleaseVerifyJob } from "@/lib/dispatch/release-verify-jobs";
import { fetchPullRequest } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { previewModeGuard } from "@/lib/preview-mode";
import { decideIntegrationResume } from "@/lib/release-integration-rerun-view";
import { isReleasePullRequest, parseReleaseVerificationState } from "@/lib/release-merge-gate";
import { resetIntegrationVerification } from "@/lib/release-verification";
import { loadReleaseVerificationProgress } from "@/lib/release-verification-load";

/**
 * 統合検証の再開（#5020）。中断（ジョブが終了・取消されたのに結果が記録されていない）または失敗した統合検証を、
 * 同じ対象で積み直す。`review-rerun`と同じ作りで、対象（base・head）はサーバーが今のリリースPRから解決し、
 * クライアントのSHAは「押したときに見ていた対象との一致確認」にだけ使う（ずれていれば409）。
 *
 * 再開できるかは記録の状態だけでなく最新ジョブの進捗で決める（`decideIntegrationResume`。応答なしは対象外）。
 * 前回の結果を消して`waiting`へ戻すのは、ジョブを積めた（`queued`）あとだけ。積めなかった場合や
 * すでに積まれている場合は記録に触れない。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("release_dispatch", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const pullRequestNumber = payload?.pullRequestNumber;
  const sha = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v) ? v : null);
  const expectedBase = sha(payload?.baseSha);
  const expectedHead = sha(payload?.headSha);
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    !Number.isInteger(pullRequestNumber) ||
    pullRequestNumber <= 0 ||
    !expectedBase ||
    !expectedHead
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await db.repository.findFirst({
    where: { fullName: `${owner}/${repo}`, installation: { userInstallations: { some: { userId } } } },
    include: { installation: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const pr = await fetchPullRequest(owner, repo, pullRequestNumber, token);
    if (!pr.base || !pr.head.ref || !isReleasePullRequest({ baseRef: pr.base.ref, headRef: pr.head.ref })) {
      return NextResponse.json({ error: "not_release_pull_request" }, { status: 404 });
    }
    if (pr.base.sha !== expectedBase || pr.head.sha !== expectedHead) {
      return NextResponse.json({ error: "release_pr_changed" }, { status: 409 });
    }
    const repoFullName = `${owner}/${repo}`;
    const target = { repoFullName, prNumber: pullRequestNumber, baseSha: pr.base.sha, headSha: pr.head.sha };

    const row = await db.releaseVerification.findFirst({ where: { ...target, kind: "integration" }, select: { state: true } });
    const state = row ? parseReleaseVerificationState(row.state) : null;
    if (!state) {
      return NextResponse.json(
        { ok: false, error: "not_requested", message: "この対象の統合検証の記録がありません。「更新」で最新の状態を読み込んでください。" },
        { status: 409 },
      );
    }
    const progress = (await loadReleaseVerificationProgress(repoFullName, pullRequestNumber, target)).integration ?? null;
    const decision = decideIntegrationResume({ state, progress, nowMs: Date.now() });
    if (!decision.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: decision.reason === "in_progress" ? "already_running" : "not_resumable",
          message:
            decision.reason === "in_progress"
              ? "統合検証は実行中または待機中です。結果が出るまでお待ちください。"
              : "この統合検証は再開できません（完了済み、または対象外です）。",
        },
        { status: 409 },
      );
    }

    const result = await requestReleaseVerifyJob(target);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.rejection, message: result.message }, { status: 409 });
    }
    if (result.outcome === "queued") await resetIntegrationVerification(target);
    return NextResponse.json({ ok: true, outcome: result.outcome }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[POST /api/repositories/release/integration-rerun] ${owner}/${repo}#${pullRequestNumber}:`, error);
    return NextResponse.json({ error: "github_api_error", message: githubApiErrorMessage(error) }, { status: 502 });
  }
}
