import { db } from "@/lib/db";
import type { CrossRepoDeps, CrossRepoIssueRef, CrossRepoOrigin } from "@/lib/dispatch/cross-repo-filing";
import { readDispatchAgent } from "@/lib/dispatch/dispatch-job";
import { enqueueDispatchJob } from "@/lib/dispatch/jobs";
import { getInstallationToken } from "@/lib/github/app-auth";
import { addIssueLabels, addSubIssue, createComment, createIssue, type GithubApiIssue } from "@/lib/github/issues-api";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import { fetchAllPages, fetchPagesUpTo } from "@/lib/github/pagination";
import { GITHUB_API } from "@/lib/github/request";

/**
 * 重複判定で遡るページ数（100件×3）。子Issueは起点の作業中に作られるため、直近の起票に必ず入る。
 * 全件を引くと大きなリポジトリで依頼のたびにレート制限を食うので上限を置く。
 */
const MARKER_SEARCH_PAGES = 3;

async function tokenFor(repository: string): Promise<string> {
  const registered = await db.repository.findFirst({ where: { fullName: repository }, include: { installation: true } });
  if (!registered) throw new Error(`${repository}はissue-deckへ登録されていません`);
  return getInstallationToken(registered.installation.installationId);
}

function toRef(issue: GithubApiIssue): CrossRepoIssueRef {
  return { number: issue.number, id: issue.id, url: issue.html_url, state: issue.state === "closed" ? "closed" : "open" };
}

function split(repository: string): [string, string] {
  const [owner, repo] = repository.split("/");
  return [owner, repo];
}

/** 実体のGitHub・DB・起動操作（GitHubへの書き込みはすべてGitHub Appのインストールトークン） */
export const defaultCrossRepoDeps: CrossRepoDeps = {
  async isRegistered(repository) {
    return (await db.repository.findFirst({ where: { fullName: repository }, select: { id: true } })) !== null;
  },

  async findIssueByMarker(repository, marker) {
    const token = await tokenFor(repository);
    const { items } = await fetchPagesUpTo<GithubApiIssue>(
      `${GITHUB_API}/repos/${repository}/issues?state=all&sort=created&direction=desc&per_page=100`,
      token,
      MARKER_SEARCH_PAGES,
    );
    // 若い番号を正とする（並行した再送で2件できても、以後は同じ1件へ収束させる）
    const matches = items.filter((i) => !i.pull_request && (i.body ?? "").includes(marker)).sort((a, b) => a.number - b.number);
    return matches[0] ? toRef(matches[0]) : null;
  },

  async createIssue(repository, input) {
    const [owner, repo] = split(repository);
    return toRef(await createIssue(owner, repo, await tokenFor(repository), input));
  },

  async listSubIssueIds(origin: CrossRepoOrigin) {
    const items = await fetchAllPages<{ id: number }>(
      `${GITHUB_API}/repos/${origin.repository}/issues/${origin.issueNumber}/sub_issues?per_page=100`,
      await tokenFor(origin.repository),
    );
    return items.map((i) => i.id);
  },

  async addSubIssue(origin, childId) {
    // 起点と起票先が別Installationでも書けるよう、起点リポジトリ自身のトークンを使う（manual-step-filingと同じ）
    const [owner, repo] = split(origin.repository);
    await addSubIssue(owner, repo, origin.issueNumber, await tokenFor(origin.repository), childId);
  },

  async findOriginLaunch(origin) {
    const job = await db.dispatchJob.findFirst({
      where: { repositoryFullName: origin.repository, issueNumber: origin.issueNumber, kind: "LAUNCH" },
      orderBy: { createdAt: "desc" },
      select: { targetHost: true, agent: true },
    });
    return job ? { hostName: job.targetHost, agent: readDispatchAgent(job.agent) } : null;
  },

  async launch({ repository, issueNumber, hostName, agent }) {
    const result = await enqueueDispatchJob({
      repositoryFullName: repository,
      issueNumber,
      hostName,
      agent: readDispatchAgent(agent),
      requestedByUserId: null,
    });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  },

  async markLocal(repository, issueNumber) {
    // 受け口にはユーザーが居ないので、GitHub Appのトークンで付ける（manual-step-filingのラベル付与と同じ）
    const [owner, repo] = split(repository);
    await addIssueLabels(owner, repo, issueNumber, await tokenFor(repository), [LOCAL_LABEL_NAME]);
  },

  async comment(origin, body) {
    const [owner, repo] = split(origin.repository);
    await createComment(owner, repo, origin.issueNumber, await tokenFor(origin.repository), { body });
  },
};
