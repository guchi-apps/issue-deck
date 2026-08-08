import { db } from "@/lib/db";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { fetchClaudeWorkflowExists } from "@/lib/github/workflow-support";
import type { Repository } from "@prisma/client";

export type GithubRepositoryResponse = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  archived: boolean;
  default_branch: string;
  owner: { login: string };
};

/** GitHub Appのインストールに紐づくリポジトリ一覧を全ページ取得する */
export async function fetchInstallationRepositories(
  installationToken: string,
): Promise<GithubRepositoryResponse[]> {
  const repositories: GithubRepositoryResponse[] = [];
  let page = 1;

  while (true) {
    const res = await githubFetch(
      `${GITHUB_API}/installation/repositories?per_page=100&page=${page}`,
      installationToken,
    );
    if (!res.ok) {
      throw new Error(`Failed to fetch installation repositories: ${res.status}`);
    }
    const data: { repositories: GithubRepositoryResponse[] } = await res.json();
    repositories.push(...data.repositories);

    if (data.repositories.length < 100) break;
    page += 1;
  }

  return repositories;
}

/**
 * GitHub上の最新のリポジトリ一覧を取得し、DBへ反映する（claude-issue-dispatch.ymlの
 * 存在チェックも行う。#720）。インストールの選択から外れたリポジトリはDBから削除する。
 */
export async function syncInstallationRepositories(
  installation: { id: string },
  installationToken: string,
): Promise<Repository[]> {
  const repositories = await fetchInstallationRepositories(installationToken);

  const savedRepositories = await Promise.all(
    repositories.map(async (repo) => {
      const hasClaudeWorkflow = await fetchClaudeWorkflowExists(
        repo.owner.login,
        repo.name,
        installationToken,
      ).catch(() => false);

      return db.repository.upsert({
        where: { githubRepositoryId: repo.id },
        create: {
          githubRepositoryId: repo.id,
          installationId: installation.id,
          ownerLogin: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          htmlUrl: repo.html_url,
          archived: repo.archived,
          defaultBranch: repo.default_branch,
          hasClaudeWorkflow,
          lastSyncedAt: new Date(),
        },
        update: {
          ownerLogin: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name,
          private: repo.private,
          htmlUrl: repo.html_url,
          archived: repo.archived,
          defaultBranch: repo.default_branch,
          hasClaudeWorkflow,
          lastSyncedAt: new Date(),
        },
      });
    }),
  );

  await db.repository.deleteMany({
    where: {
      installationId: installation.id,
      githubRepositoryId: { notIn: repositories.map((repo) => repo.id) },
    },
  });

  return savedRepositories;
}
