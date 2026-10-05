import { db } from "@/lib/db";
import { createIssue } from "@/lib/github/issues-api";
import { upsertIssueAndGetDisplay } from "@/lib/github/sync-issues";
import {
  withUserGithubToken,
  type WithUserGithubTokenResult,
} from "@/lib/github/with-user-github-token";

/**
 * Issue作成の本体（#3975）。画面の起案（`POST /api/issues`）とIssueDeck Chatの確認カードが
 * 同じ関数を呼ぶ。ユーザー本人のトークン取得・GitHubへの作成・DBへの反映までを持つ。
 */

export type IssueCreateRequest = {
  repositoryFullName: string;
  title: string;
  body?: string;
  labels?: string[];
  assignee?: string;
};

type CreateIssueUser = {
  id: string;
  githubAccessToken: string | null;
  githubRefreshToken: string | null;
};

export async function findRepositoryByFullName(userId: string, repositoryFullName: string) {
  return db.repository.findFirst({
    where: {
      fullName: repositoryFullName,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

type Repository = NonNullable<Awaited<ReturnType<typeof findRepositoryByFullName>>>;

export type CreatedIssueDisplay = Awaited<ReturnType<typeof upsertIssueAndGetDisplay>>;

export async function createIssueForUser(
  user: CreateIssueUser,
  repository: Repository,
  request: IssueCreateRequest,
): Promise<WithUserGithubTokenResult<CreatedIssueDisplay>> {
  const [owner, repo] = request.repositoryFullName.split("/");
  return withUserGithubToken(user, `POST /api/issues ${request.repositoryFullName}`, async (token) => {
    const created = await createIssue(owner, repo, token, {
      title: request.title.trim(),
      body: request.body?.trim() ? request.body : undefined,
      labels: request.labels,
      assignees: request.assignee ? [request.assignee] : undefined,
    });
    return upsertIssueAndGetDisplay(repository, created);
  });
}
