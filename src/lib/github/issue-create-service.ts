import { db } from "@/lib/db";
import { getAppAiToken } from "@/lib/claude/request";
import { generateIssueSuggestion } from "@/lib/claude/issue-suggest";
import { createIssue, updateIssue } from "@/lib/github/issues-api";
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

/**
 * タイトル空欄で作ったIssueへ、本文からAIが付けたタイトルを書き込む（#4298）。
 * **ベストエフォート**: AI未設定・失敗・GitHubへの更新失敗では何も変えず、仮タイトルのまま残す
 * （作成そのものは成功している）。呼び出し元は応答を返したあとに走らせる。
 */
export async function fillIssueTitleByAi(
  user: CreateIssueUser,
  repository: Repository,
  issue: { number: number; title: string },
  body: string,
): Promise<void> {
  try {
    const aiToken = await getAppAiToken("issue_suggest");
    if (!aiToken || !body.trim()) return;
    const suggestion = await generateIssueSuggestion(
      aiToken,
      { body, availableLabels: [] },
      { includeLabels: false },
    );
    if (!suggestion.title) return;
    const [owner, repo] = repository.fullName.split("/");
    const updated = await withUserGithubToken(
      user,
      `PATCH /api/share/issues ${repository.fullName}#${issue.number}`,
      (token) => updateIssue(owner, repo, issue.number, token, { title: suggestion.title }),
    );
    if ("errorResponse" in updated) return;
    await upsertIssueAndGetDisplay(repository, updated.value);
  } catch (error) {
    console.error("[share] タイトルの自動記入に失敗しました（仮タイトルのまま）", error);
  }
}
