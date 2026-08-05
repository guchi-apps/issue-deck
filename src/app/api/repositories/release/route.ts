import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  dispatchReleaseWorkflow,
  fetchLatestDeployWorkflowRun,
  fetchLatestReleaseWorkflowRun,
  fetchOpenPullRequestsForBase,
  fetchPackageVersion,
  fetchRefCiState,
  fetchReleaseWorkflowExists,
} from "@/lib/github/release-api";

/**
 * `release-develop-to-main.yml`の有無はほとんど変化しないため、ポーリングのたびに問い合わせず
 * プロセス内にキャッシュしてGitHub APIの消費を抑える。
 * 本番はPM2のfork（単一プロセス）で動作し、プロセスが入れ替わればキャッシュは空になる。
 */
const RELEASE_WORKFLOW_EXISTS_TTL_MS = 10 * 60_000;
const releaseWorkflowExistsCache = new Map<string, { exists: boolean; cachedAt: number }>();

async function releaseWorkflowExists(owner: string, repo: string, token: string): Promise<boolean> {
  const key = `${owner}/${repo}`;
  const cached = releaseWorkflowExistsCache.get(key);
  if (cached && Date.now() - cached.cachedAt < RELEASE_WORKFLOW_EXISTS_TTL_MS) {
    return cached.exists;
  }
  const exists = await fetchReleaseWorkflowExists(owner, repo, token);
  releaseWorkflowExistsCache.set(key, { exists, cachedAt: Date.now() });
  return exists;
}

/** バンプPRのブランチ名（`release/v1.2.3`）から次バージョンを取り出す */
function versionFromBranch(ref: string): string | null {
  const match = /^release\/v(.+)$/.exec(ref);
  return match ? match[1] : null;
}

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
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
    const available = await releaseWorkflowExists(owner, repo, token);
    if (!available) {
      return NextResponse.json({ available: false });
    }

    const [
      mainVersion,
      developVersion,
      developBasePullRequests,
      mainBasePullRequests,
      workflowRun,
      deployWorkflowRun,
    ] = await Promise.all([
      fetchPackageVersion(owner, repo, "main", token),
      fetchPackageVersion(owner, repo, "develop", token),
      fetchOpenPullRequestsForBase(owner, repo, "develop", token),
      fetchOpenPullRequestsForBase(owner, repo, "main", token),
      fetchLatestReleaseWorkflowRun(owner, repo, token),
      fetchLatestDeployWorkflowRun(owner, repo, token),
    ]);

    const bumpPr = developBasePullRequests.find((pr) => pr.head.ref.startsWith("release/v")) ?? null;
    const releasePr = mainBasePullRequests.find((pr) => pr.head.ref === "develop") ?? null;

    // バンプPR・develop→mainのPRが開いている間だけCI状態を取得する（マージしてよいかの目安として表示する）。
    const [bumpCiState, releaseCiState] = await Promise.all([
      bumpPr ? fetchRefCiState(owner, repo, bumpPr.head.ref, token) : Promise.resolve(null),
      releasePr ? fetchRefCiState(owner, repo, releasePr.head.ref, token) : Promise.resolve(null),
    ]);

    // 進捗の論理段階を版数とオープン中PRから判定する（このAPI以外に状態は持たない）。
    // - bump_pr_open:   バンプPRがオープン中（CI・developマージ待ち）
    // - release_pr_open: develop→mainのPRがオープン中（mainマージ待ち＝人手）
    // - release_pending: developがbump済み（版数がmainと異なる）だがdevelop→mainのPRは未作成
    //                    （auto-merge直後などの過渡状態。push起動でまもなくPRが作られる）
    // - none:           対象なし、または一連の反映が完了した状態
    const phase = bumpPr
      ? "bump_pr_open"
      : releasePr
        ? "release_pr_open"
        : mainVersion && developVersion && mainVersion !== developVersion
          ? "release_pending"
          : "none";

    return NextResponse.json({
      available: true,
      mainVersion,
      developVersion,
      phase,
      workflowRun,
      deployWorkflowRun,
      bumpPullRequest: bumpPr
        ? {
            number: bumpPr.number,
            url: bumpPr.html_url,
            title: bumpPr.title,
            ciState: bumpCiState,
            version: versionFromBranch(bumpPr.head.ref),
          }
        : null,
      releasePullRequest: releasePr
        ? {
            number: releasePr.number,
            url: releasePr.html_url,
            title: releasePr.title,
            ciState: releaseCiState,
          }
        : null,
    });
  } catch (error) {
    console.error(`[GET /api/repositories/release] ${owner}/${repo}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export function POST(request: NextRequest) {
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

  if (typeof owner !== "string" || typeof repo !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    await dispatchReleaseWorkflow(owner, repo, token);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(`[POST /api/repositories/release] ${owner}/${repo}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
