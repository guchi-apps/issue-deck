import type { EpicGithub } from "@/lib/epic-draft/create";
import { addSubIssue, createIssue, fetchIssuesForRepo, updateIssue } from "@/lib/github/issues-api";
import { fetchSubIssueRelations } from "@/lib/github/sub-issues-api";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";

type GithubUserTokenUser = { id: string; githubAccessToken: string | null; githubRefreshToken: string | null };

function split(repo: string): [string, string] {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`リポジトリ名が不正です: ${repo}`);
  return [owner, name];
}

/** 依頼者のGitHubトークンで動くEpicGithub。`withUserGithubToken`の失敗は投げ直す（未作成と解釈させない） */
export function githubForUser(user: GithubUserTokenUser): EpicGithub {
  const run = async <T>(label: string, fn: (token: string) => Promise<T>): Promise<T> => {
    const result = await withUserGithubToken(user, `epic-draft ${label}`, fn);
    if (!("value" in result)) {
      const body = await result.errorResponse.json().catch(() => ({}));
      throw new Error(typeof body?.message === "string" ? body.message : `GitHubの操作に失敗しました（${label}）`);
    }
    return result.value;
  };
  return {
    listIssues: (repo) =>
      run(`list ${repo}`, async (token) => {
        const [owner, name] = split(repo);
        const issues = await fetchIssuesForRepo(owner, name, token);
        return issues.map((i) => ({ number: i.number, id: i.id, state: i.state, body: i.body }));
      }),
    createIssue: (repo, input) =>
      run(`create ${repo}`, async (token) => {
        const [owner, name] = split(repo);
        const created = await createIssue(owner, name, token, { title: input.title, body: input.body });
        return { number: created.number, id: created.id };
      }),
    updateBody: (repo, number, body) =>
      run(`update ${repo}#${number}`, async (token) => {
        const [owner, name] = split(repo);
        await updateIssue(owner, name, number, token, { body });
      }),
    listSubIssues: (repo, number) =>
      run(`sub-issues ${repo}#${number}`, async (token) => {
        const [owner, name] = split(repo);
        const relations = await fetchSubIssueRelations(token, owner, name, number);
        return relations.children.map((c) => ({ repo: c.repositoryFullName, number: c.number }));
      }),
    addSubIssue: (parent, childId) =>
      run(`link ${parent.repo}#${parent.number}`, async (token) => {
        const [owner, name] = split(parent.repo);
        await addSubIssue(owner, name, parent.number, token, childId);
      }),
  };
}
