import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  extractBumpChangelog,
  extractBumpReason,
  extractBumpUsage,
} from "@/lib/github/release-bump-reason";
import { repairKindsFor } from "@/lib/github/pull-request-repair";
import {
  fetchActivePullRequestRepairRuns,
  repairRunKey,
} from "@/lib/github/pull-request-repair-run";
import { extractLinkedIssueNumbers } from "@/lib/github/release-pr-issue-link";
import {
  dispatchReleaseWorkflow,
  fetchLatestDeployWorkflowRun,
  fetchLatestReleaseWorkflowRun,
  fetchOpenPullRequestsForBase,
  fetchPackageVersion,
  fetchPullRequestCiState,
} from "@/lib/github/release-api";
import { GithubApiError } from "@/lib/github/github-api-error";
import { releaseWorkflowExists } from "@/lib/github/release-workflow-cache";
import { fetchRepairWorkflowAvailability } from "@/lib/github/repair-workflow-cache";
import { previewModeGuard } from "@/lib/preview-mode";
import { isBumpKind } from "@/lib/semver-bump";

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

    // バンプPR自身を除いた、develop向けのその他のオープンPR一覧。Issueを起票せず直接
    // developへPRを作った場合に気づけるよう、リリース確認ダイアログで一覧表示する(#977)。
    const otherPullRequests = developBasePullRequests
      .filter((pr) => pr.number !== bumpPr?.number)
      .map((pr) => ({
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        issueNumbers: extractLinkedIssueNumbers(pr.title, pr.body),
      }));

    // バンプPR・develop→mainのPRが開いている間だけCI状態を取得する（マージしてよいかの目安として表示する）。
    // コンフリクト有無（`mergeable`）は自動解消ボタンを出すかどうかの判定に必要で（#1293）、
    // CI状態と**同じ1回のGraphQL**で取れる（#1742）。PRが開いていない間はどちらも取得しない。
    const [bumpState, releaseState] = await Promise.all([
      bumpPr ? fetchPullRequestCiState(owner, repo, bumpPr.number, token) : Promise.resolve(null),
      releasePr
        ? fetchPullRequestCiState(owner, repo, releasePr.number, token)
        : Promise.resolve(null),
    ]);

    // 段に添える修復ボタンが実際に起動できるかを確かめる（#1960）。バンプPR・リリースPRを
    // 直すのは`claude-pr-repair.yml`で、リリースフローを持っていても未配布のことがある。
    // ボタンを出す段（CI失敗・コンフリクト）だけ問い合わせ、結果は10分キャッシュされる。
    const [bumpRepairAvailability, releaseRepairAvailability] = await Promise.all([
      bumpPr
        ? fetchRepairWorkflowAvailability(
            owner,
            repo,
            { number: bumpPr.number, baseRef: "develop", headRef: bumpPr.head.ref },
            repairKindsFor(
              { state: "open", draft: false, ciState: bumpState?.ciState ?? null },
              bumpState?.mergeable ?? null,
            ),
            token,
          )
        : Promise.resolve({}),
      releasePr
        ? fetchRepairWorkflowAvailability(
            owner,
            repo,
            { number: releasePr.number, baseRef: "main", headRef: releasePr.head.ref },
            repairKindsFor(
              { state: "open", draft: false, ciState: releaseState?.ciState ?? null },
              releaseState?.mergeable ?? null,
            ),
            token,
          )
        : Promise.resolve({}),
    ]);

    // いま走っている自動修復（#2072）。バンプPR・リリースPRを直すのは`claude-pr-repair.yml`で、
    // 走っているあいだは段に「自動修正中」を出してボタンを押せなくする。DBを1回引くだけ。
    const repairRuns = await fetchActivePullRequestRepairRuns(
      [bumpPr?.number, releasePr?.number]
        .filter((number): number is number => number !== undefined)
        .map((number) => ({ repositoryFullName: `${owner}/${repo}`, pullRequestNumber: number })),
    );

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
            ciState: bumpState?.ciState ?? null,
            mergeable: bumpState?.mergeable ?? null,
            repairWorkflowAvailability: bumpRepairAvailability,
            repairRun: repairRuns.get(repairRunKey(`${owner}/${repo}`, bumpPr.number)) ?? null,
            version: versionFromBranch(bumpPr.head.ref),
            reason: extractBumpReason(bumpPr.body),
            changelog: extractBumpChangelog(bumpPr.body),
            usage: extractBumpUsage(bumpPr.body),
          }
        : null,
      releasePullRequest: releasePr
        ? {
            number: releasePr.number,
            url: releasePr.html_url,
            title: releasePr.title,
            ciState: releaseState?.ciState ?? null,
            mergeable: releaseState?.mergeable ?? null,
            repairWorkflowAvailability: releaseRepairAvailability,
            repairRun: repairRuns.get(repairRunKey(`${owner}/${repo}`, releasePr.number)) ?? null,
          }
        : null,
      otherPullRequests,
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
  // バージョンの上げ幅の指定（#1548）。省略時は従来どおりworkflow内のClaudeが判定する。
  const bumpKind = payload?.bumpKind;

  if (typeof owner !== "string" || typeof repo !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (bumpKind !== undefined && bumpKind !== null && !isBumpKind(bumpKind)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    // 起動前にworkflowの有無を確かめる（#1538）。無いリポジトリでdispatchすると、GitHubの
    // 生の404本文がそのまま画面へ出て「何が足りないのか」が読み取れないため、ここで止めて
    // 専用のエラーコードを返す。判定は取得側と同じキャッシュを通るので追加の消費はほぼ無い。
    const available = await releaseWorkflowExists(owner, repo, token);
    if (!available) {
      return NextResponse.json({ error: "release_workflow_missing" }, { status: 400 });
    }

    await dispatchReleaseWorkflow(owner, repo, token, isBumpKind(bumpKind) ? bumpKind : undefined);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // 上げ幅を指定したのに、workflowがそのinputを持たないリポジトリ（#1548）。GitHubは
    // `Unexpected inputs provided`の422で落とす。**起動そのものの失敗と混ぜない**——
    // 自動判定で押し直せば通る、という次の手が画面から読み取れる必要があるため。
    if (isBumpKind(bumpKind) && error instanceof GithubApiError && error.status === 422) {
      return NextResponse.json({ error: "bump_kind_unsupported" }, { status: 400 });
    }
    console.error(`[POST /api/repositories/release] ${owner}/${repo}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
