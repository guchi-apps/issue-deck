import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { updatePullRequestBranch } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/issues-api";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { previewModeGuard } from "@/lib/preview-mode";
import { classifyUpdateBranch422, decideUpdateBranch } from "@/lib/pull-request-update-branch";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_update_branch", () => handlePOST(request));
}

/**
 * PR詳細の「最新のbaseを取り込む」（#4626）。headブランチへbaseをマージするだけで、
 * PRのマージ・自動マージの有効化はしない（既存の自動マージ判定へ任せる）。
 *
 * 画面の値は信用せず、GitHubから現在のPRを取り直して`decideUpdateBranch`で判定し、
 * 期待したheadSHAをGitHubへも渡す（処理中にheadが変わっても別の対象を更新しない）。
 */
async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload: { owner?: unknown; repo?: unknown; number?: unknown; headSha?: unknown } = await request
    .json()
    .catch(() => ({}));
  const { owner, repo, number, headSha } = payload;
  if (
    typeof owner !== "string" ||
    !owner ||
    typeof repo !== "string" ||
    !repo ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    typeof headSha !== "string" ||
    !headSha
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const current = await fetchPullRequest(owner, repo, number, token);
    const decision = decideUpdateBranch(
      {
        state: current.state,
        merged: current.merged,
        baseRef: current.base.ref,
        headRef: current.head.ref,
        headSha: current.head.sha,
        headRepoFullName: current.head.repo?.full_name ?? null,
        baseRepoFullName: repository.fullName,
        mergeableState: current.mergeable_state,
      },
      headSha,
    );
    if (decision.action === "reject") {
      return NextResponse.json({ error: decision.code }, { status: 409 });
    }
    await updatePullRequestBranch(owner, repo, number, current.head.sha, token);
    // 202＝受け付けた。取り込み完了（新しいhead）は画面が再取得で確認する
    return NextResponse.json({ ok: true, baseRef: current.base.ref, previousHeadSha: current.head.sha });
  } catch (error) {
    if (error instanceof GithubApiError) {
      if (error.status === 404) return NextResponse.json({ error: "not_found" }, { status: 404 });
      if (error.status === 403) return NextResponse.json({ error: "permission_denied" }, { status: 403 });
      if (error.status === 422) {
        const code = classifyUpdateBranch422(error.message);
        if (code) return NextResponse.json({ error: code }, { status: 409 });
        // 分類できない422（ブランチ保護など）は「取り込み済み」にせず、失敗として応答の内容を返す
        return NextResponse.json({ error: "github_api_error", message: error.message }, { status: 502 });
      }
    }
    console.error(`[POST /api/pull-requests/update-branch] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
