import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { lookupBranchRefs } from "@/lib/github/branches-api";
import { releaseWorkflowExists } from "@/lib/github/release-workflow-cache";
import { ACTIVE_ISSUE_PROGRESS_STATUSES, issueBranchName } from "@/lib/branch-flow";
import { getProgressStatusDef } from "@/lib/issue-progress";
import type { BranchFlowResponse, RepositoryBranchStatus } from "@/types/branch-flow";

export function GET() {
  return withGithubApiFeature("branch_flow", () => handleGET());
}

/**
 * リポジトリ横断のブランチ状況を返す（#1455）。
 *
 * 「ブランチ」画面のうち、**PRからは分からない部分だけ**をここで取りに行く。
 * PRの一覧は`/api/pull-requests`が、Issueの情報はDBキャッシュが既に持っているため、
 * この画面のために増えるGitHub APIの消費は**リポジトリあたり1回**（GraphQL）だけ。
 * リリース用workflowの有無だけは追加で問い合わせるが、10分間プロセス内にキャッシュされ、
 * ヘッダーのリリース状態取得と共有される（#1538）。
 *
 * 問い合わせるのは「進行中のIssueに対応するブランチ（`issue-<番号>`）が実在するか」と
 * 「`main`と`develop`の差分」。ブランチの列挙はしない（理由は`lib/github/branches-api.ts`）。
 *
 * PR一覧と同じく**キャッシュもポーリングも持たない**。画面を開いたときと更新操作のときだけ走る。
 */
async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 母集団はPR一覧（`/api/pull-requests`）と揃える。片方にしか出ないリポジトリがあると、
  // 同じ画面の中でPRとブランチの母集団が食い違う。
  const hiddenRepositoryIds = (
    await db.hiddenRepository.findMany({ where: { userId }, select: { repositoryId: true } })
  ).map((row) => row.repositoryId);

  const repositories = await db.repository.findMany({
    where: {
      archived: false,
      id: { notIn: hiddenRepositoryIds },
      installation: { userInstallations: { some: { userId } } },
    },
    orderBy: { fullName: "asc" },
    include: { installation: true },
  });

  if (repositories.length === 0) {
    const empty: BranchFlowResponse = {
      repositories: [],
      fetchedAt: new Date().toISOString(),
      failedRepositories: [],
    };
    return NextResponse.json(empty);
  }

  // 存在を確認するブランチは、進行中のIssueから組み立てる。これが「ブランチは上がっているが
  // PRがまだ無い」を出すための材料になる。マージ済みのIssueぶんは確認しない——ブランチが
  // 残っているかどうかを画面に出さないと決めたため（数百本残っているのが常態のため）。
  const activeIssues = await db.issue.findMany({
    where: {
      state: "OPEN",
      repositoryId: { in: repositories.map((repository) => repository.id) },
      projectStatus: {
        in: ACTIVE_ISSUE_PROGRESS_STATUSES.map((key) => getProgressStatusDef(key).projectStatus),
      },
    },
    select: { number: true, repositoryId: true },
  });

  const branchesByRepositoryId = new Map<string, string[]>();
  for (const issue of activeIssues) {
    const branches = branchesByRepositoryId.get(issue.repositoryId) ?? [];
    branches.push(issueBranchName(issue.number));
    branchesByRepositoryId.set(issue.repositoryId, branches);
  }

  // 同一installationのリポジトリ間でトークン取得を使い回す（PR一覧と同じ方針）。
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const failedRepositories: string[] = [];

  const results = await Promise.all(
    repositories.map(async (repository): Promise<RepositoryBranchStatus | null> => {
      const checkedBranches = branchesByRepositoryId.get(repository.id) ?? [];
      try {
        const token = await tokenFor(repository.installation.installationId);
        const [lookup, hasReleaseWorkflow] = await Promise.all([
          lookupBranchRefs(repository.ownerLogin, repository.name, checkedBranches, token),
          // 「リリースする」を出してよいかは、リリース用workflowの有無で決める（#1538）。
          // `claude-issue-dispatch.yml`の有無（`hasClaudeWorkflow`）で代用していたため、
          // Claude運用に載っているだけでリリース用workflowを持たないリポジトリにもボタンが
          // 出て、押すとdispatchが404で失敗していた。
          // 判定はヘッダーのロケットボタン（`/api/repositories/release`）と同じ関数を通す。
          // プロセス内に10分キャッシュされ、多くの場合そのポーリングと共有されるため、
          // この画面のためのGitHub API消費はほとんど増えない。取れなかった場合はfalseへ
          // 縮退させ、押せない側へ倒す。
          releaseWorkflowExists(repository.ownerLogin, repository.name, token).catch((error) => {
            console.error(`[GET /api/branch-flow] release workflow ${repository.fullName}:`, error);
            return false;
          }),
        ]);

        return {
          repositoryFullName: repository.fullName,
          checkedBranches,
          existingBranches: lookup.existingBranches,
          developVsMain: lookup.developVsMain,
          hasReleaseWorkflow,
        };
      } catch (error) {
        // 1リポジトリの取得失敗で画面全体を落とさない。取れなかったことだけを返す。
        console.error(`[GET /api/branch-flow] ${repository.fullName}:`, error);
        failedRepositories.push(repository.fullName);
        return null;
      }
    }),
  );

  const response: BranchFlowResponse = {
    repositories: results.filter((result) => result !== null),
    fetchedAt: new Date().toISOString(),
    failedRepositories: failedRepositories.sort((a, b) => a.localeCompare(b)),
  };
  return NextResponse.json(response);
}
