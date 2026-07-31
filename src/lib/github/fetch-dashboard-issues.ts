import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchIssuesForRepo } from "@/lib/github/issues-api";
import { mapIssue } from "@/lib/github/issue-mapper";
import type { Issue } from "@/types/issue";

type RepoForFetch = {
  ownerLogin: string;
  name: string;
  fullName: string;
  installation: { installationId: number };
};

export type FetchIssuesError = {
  repo: string;
  message: string;
};

export async function fetchDashboardIssues(
  repositories: RepoForFetch[],
): Promise<{ issues: Issue[]; errors: FetchIssuesError[] }> {
  const installationIds = [...new Set(repositories.map((r) => r.installation.installationId))];

  const tokenEntries = await Promise.all(
    installationIds.map(async (id) => [id, await getInstallationToken(id)] as const),
  );
  const tokenByInstallationId = new Map(tokenEntries);

  const results = await Promise.allSettled(
    repositories.map(async (repo) => {
      const token = tokenByInstallationId.get(repo.installation.installationId);
      if (!token) {
        throw new Error("インストールトークンを取得できませんでした");
      }
      const rawIssues = await fetchIssuesForRepo(repo.ownerLogin, repo.name, token);
      return rawIssues.map((raw) => mapIssue(repo.fullName, raw));
    }),
  );

  const issues: Issue[] = [];
  const errors: FetchIssuesError[] = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      issues.push(...result.value);
    } else {
      errors.push({
        repo: repositories[index].fullName,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  return { issues, errors };
}
