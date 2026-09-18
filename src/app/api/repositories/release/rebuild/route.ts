import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { closePullRequest } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import { createComment } from "@/lib/github/issues-api";
import {
  deleteBranch,
  dispatchReleaseWorkflow,
  fetchOpenPullRequestsForBase,
  fetchReleaseRebuildCandidate,
  type GithubApiPullRequest,
} from "@/lib/github/release-api";
import { releaseWorkflowExists } from "@/lib/github/release-workflow-cache";
import { previewModeGuard } from "@/lib/preview-mode";
import { canRebuildRelease, releaseRebuildCloseComment } from "@/lib/release-rebuild";
import { isBumpKind } from "@/lib/semver-bump";

/**
 * リリースの作り直し（#3014）。
 *
 * - GET: 開いているリリースPRと、その後にdevelopへ入った変更（確認ダイアログの材料）
 * - POST: リリースPRを閉じて凍結ブランチを消し、リリースworkflowを起動し直す。workflowが
 *   前回のバンプを取り消してバンプから作り直す（`reusable-release-develop-to-main.yml`）
 *
 * **作り直せるのはheadが凍結ブランチ`release-main/vX.Y.Z`のリリースPRだけ。** 参照タグが古い
 * リポジトリではheadが`develop`のことがあり（#2117以前）、その場合にブランチを消すとdevelopが
 * 消える。凍結されていないPRはdevelopの先端を追うので、そもそも作り直す必要も無い。
 */

const FROZEN_RELEASE_PREFIX = "release-main/v";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

async function findFrozenReleasePullRequest(
  owner: string,
  repo: string,
  token: string,
): Promise<GithubApiPullRequest | null> {
  const pullRequests = await fetchOpenPullRequestsForBase(owner, repo, "main", token);
  return pullRequests.find((pr) => pr.head.ref.startsWith(FROZEN_RELEASE_PREFIX)) ?? null;
}

function githubError(label: string, error: unknown) {
  console.error(`[${label} /api/repositories/release/rebuild]`, error);
  return NextResponse.json(
    { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
    { status: 502 },
  );
}

export function GET(request: NextRequest) {
  return withGithubApiFeature("release_status", () => handleGET(request));
}

async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  if (!owner || !repo) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const releasePr = await findFrozenReleasePullRequest(owner, repo, token);
    if (!releasePr) {
      return NextResponse.json({ releasePullRequest: null, candidate: null });
    }
    const candidate = await fetchReleaseRebuildCandidate(owner, repo, releasePr.head.sha, token);
    return NextResponse.json({
      releasePullRequest: {
        number: releasePr.number,
        title: releasePr.title,
        url: releasePr.html_url,
        version: releasePr.head.ref.slice(FROZEN_RELEASE_PREFIX.length),
      },
      candidate,
    });
  } catch (error) {
    return githubError("GET", error);
  }
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("release_dispatch", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const pullRequestNumber = payload?.pullRequestNumber;
  const bumpKind = payload?.bumpKind;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof pullRequestNumber !== "number" ||
    (bumpKind !== undefined && bumpKind !== null && !isBumpKind(bumpKind))
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let closed = false;
  try {
    const token = await getInstallationToken(repository.installation.installationId);
    if (!(await releaseWorkflowExists(owner, repo, token))) {
      return NextResponse.json({ error: "release_workflow_missing" }, { status: 400 });
    }

    // ダイアログを開いた後にマージ・作り直しされていないかを確かめる。別のPRを閉じないため、
    // 押したときに見ていたPR番号と一致するものだけを対象にする。
    const releasePr = await findFrozenReleasePullRequest(owner, repo, token);
    if (!releasePr || releasePr.number !== pullRequestNumber) {
      return NextResponse.json({ error: "release_pr_changed" }, { status: 409 });
    }
    const candidate = await fetchReleaseRebuildCandidate(owner, repo, releasePr.head.sha, token);
    if (!canRebuildRelease(candidate)) {
      return NextResponse.json({ error: "nothing_to_rebuild" }, { status: 409 });
    }

    // **閉じてから起動する。** 先に起動すると、workflowの状態判定が「リリースPRが開いている」
    // と見てスキップすることがある。
    await createComment(owner, repo, releasePr.number, token, {
      body: releaseRebuildCloseComment(candidate),
    });
    await closePullRequest(owner, repo, releasePr.number, token);
    closed = true;
    await deleteBranch(owner, repo, releasePr.head.ref, token);
    await dispatchReleaseWorkflow(owner, repo, token, isBumpKind(bumpKind) ? bumpKind : undefined);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // 起動だけが落ちた場合は、リリースPRが閉じたまま残る。画面の「リリースする」から
    // 起動し直せば同じ作り直しになる（workflowの判定は手動起動なら同じ）ことを伝える。
    if (closed) {
      const bumpKindUnsupported =
        isBumpKind(bumpKind) && error instanceof GithubApiError && error.status === 422;
      console.error("[POST /api/repositories/release/rebuild] dispatch failed after close", error);
      return NextResponse.json(
        { error: bumpKindUnsupported ? "rebuild_dispatch_bump_kind_unsupported" : "rebuild_dispatch_failed" },
        { status: 502 },
      );
    }
    return githubError("POST", error);
  }
}
