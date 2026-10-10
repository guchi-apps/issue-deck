import { db } from "@/lib/db";
import { notifyDispatchHostWake } from "@/lib/dispatch/wake-notify";
import { resolveImplementationProvider } from "@/lib/dispatch/implementation-provider";
import { DISPATCH_HOST_ONLINE_WINDOW_MS, buildDispatchActiveKey, parseDispatchHostRepositories } from "@/lib/dispatch/dispatch-job";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

export type Comment = { body: string; created_at: string; author_association?: string; user?: { login: string } };
export type ReviewFixTarget = { repository: string; issueNumber: number; pullRequest: number; headSha: string; manual: boolean; runId?: string };
const activeStatuses = ["QUEUED", "CLAIMED", "RUNNING"] as const;

export function trustedComment(comment: Comment): boolean {
  return /^(OWNER|MEMBER|COLLABORATOR)$/.test(comment.author_association ?? "") || ["claude[bot]", "issue-deck[bot]", "github-actions[bot]"].includes(comment.user?.login ?? "");
}

export function selectReviewFixComments(comments: Comment[], sha: string, manual: boolean): string | null {
  const latest = new Map<string, Comment>();
  for (const comment of [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (!trustedComment(comment)) continue;
    const match = comment.body.match(new RegExp(`<!-- issue-deck(-codex)?-review-verdict:(lgtm|needs-check|changes-requested) sha=${sha} -->`));
    if (match) latest.set(match[1] ? "codex" : "claude", comment);
  }
  const changes = [...latest.values()].filter((c) => c.body.includes(`changes-requested sha=${sha} -->`));
  if (!changes.length) return null;
  if (!manual && ([...latest.values()].some((c) => c.body.includes(`needs-check sha=${sha} -->`)) || changes.some((c) => !c.body.includes(`<!-- issue-deck-review-autofix:ok sha=${sha} -->`)))) return null;
  return changes.map((c) => c.body).join("\n\n---\n\n");
}

async function githubJson<T>(path: string, token: string): Promise<T> {
  const response = await githubFetch(`${GITHUB_API}/${path}`, token);
  if (!response.ok) throw new Error(`GitHubの状態を確認できません（HTTP ${response.status}）`);
  return response.json() as Promise<T>;
}
export async function fetchAllComments(repository: string, number: number, token: string) {
  const all: Comment[] = [];
  for (let page = 1; ; page++) {
    const rows = await githubJson<Comment[]>(`repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`, token);
    all.push(...rows);
    if (rows.length < 100) return all;
  }
}

/** 依頼時・実行直前・push直前に同じ正本を検証する。コメント本文は依頼元から受け取らない。 */
export async function validateReviewFixTarget(target: ReviewFixTarget) {
  if (await resolveImplementationProvider(target.repository, target.issueNumber) !== "codex") throw new Error("実装担当がCodexと確認できないため停止しました");
  const repository = await db.repository.findFirst({ where: { fullName: target.repository }, include: { installation: true } });
  if (!repository) throw new Error("登録済みリポジトリが見つかりません");
  const token = await getInstallationToken(repository.installation.installationId);
  const [pr, issue, reviews, handoffs] = await Promise.all([
    githubJson<{ state: string; draft: boolean; head: { sha: string; ref: string; repo: { full_name: string } }; base: { ref: string } }>(`repos/${target.repository}/pulls/${target.pullRequest}`, token),
    githubJson<{ state: string; labels: { name: string }[] }>(`repos/${target.repository}/issues/${target.issueNumber}`, token),
    fetchAllComments(target.repository, target.pullRequest, token), fetchAllComments(target.repository, target.issueNumber, token),
  ]);
  if (pr.state !== "open" || pr.draft || issue.state !== "open" || pr.head.sha !== target.headSha || pr.head.ref !== `issue-${target.issueNumber}` || pr.head.repo.full_name !== target.repository || !["main", "develop"].includes(pr.base.ref)) throw new Error("PRのHEAD・ブランチ・状態が変わったため停止しました");
  if (issue.labels.some((l) => l.name === "11.local" || l.name === "00.check-user")) throw new Error("ローカル対応中または確認待ちのため停止しました");
  if (!target.manual) {
    const handed = handoffs.filter((c) => trustedComment(c) && c.body.includes("<!-- issue-deck-review-fix:handoff sha="));
    if (handed.length > 2 || !handed.some((c) => c.body.includes(`<!-- issue-deck-review-fix:handoff sha=${target.headSha} -->`))) throw new Error("有効な自動修正の引継ぎがありません");
  }
  const review = selectReviewFixComments(reviews, target.headSha, target.manual);
  if (!review) throw new Error("現在のHEADに修正対象のレビュー指摘がありません");
  const sessions = await db.dispatchSession.count({ where: { repositoryFullName: target.repository, issueNumber: target.issueNumber, state: "ALIVE" } });
  if (sessions) throw new Error("同じIssueの実装セッションが残っているため停止しました");
  const jobs = await db.dispatchJob.count({ where: { repositoryFullName: target.repository, issueNumber: target.issueNumber, kind: { in: ["LAUNCH", "INSTRUCTION"] }, status: { in: [...activeStatuses] } } });
  if (jobs) throw new Error("同じIssueの実装ジョブが動いているため停止しました");
  return review;
}

export async function requestReviewFixJob(target: ReviewFixTarget) {
  await validateReviewFixTarget(target);
  // 画面の起動ボタンが記録した仮のrunningを片付け、以降はDispatchJobだけを正にする。
  await db.pullRequestRepairRun.updateMany({ where: { repositoryFullName: target.repository, pullRequestNumber: target.pullRequest, kind: "review", status: "running" }, data: { status: "finished", finishedAt: new Date() } });
  // 同じHEADを二重に修正しない。失敗時は人が理由を確認する（同SHAの再実行も重複として返す）。
  const where = { kind: "REVIEW_FIX" as const, repositoryFullName: target.repository, issueNumber: target.issueNumber, headSha: target.headSha };
  const prior = await db.dispatchJob.findFirst({ where, orderBy: { createdAt: "desc" } });
  if (prior && (!target.manual || ["QUEUED", "CLAIMED", "RUNNING", "SUCCEEDED"].includes(prior.status) || prior.workflowRunId === target.runId)) return prior;
  const hosts = await db.dispatchHost.findMany({ where: { reviewFixCapable: true, codexCapable: true, lastSeenAt: { gte: new Date(Date.now() - DISPATCH_HOST_ONLINE_WINDOW_MS) } }, orderBy: { name: "asc" } });
  const host = hosts.find((h) => parseDispatchHostRepositories(h.repositories).includes(target.repository));
  if (!host) throw new Error("レビュー修正に対応するサブPCがありません。pollerを更新し、オンライン状態を確認してください");
  try {
    const created = await db.dispatchJob.create({ data: { ...where, targetHost: host.name, agent: "codex", status: "QUEUED", prNumber: target.pullRequest, instruction: target.manual ? "manual" : "automatic", workflowRunId: target.runId ?? null, activeKey: buildDispatchActiveKey(target.repository, target.issueNumber), } });
    notifyDispatchHostWake(created.targetHost);
    return created;
  } catch (error) {
    const raced = await db.dispatchJob.findFirst({ where, orderBy: { createdAt: "desc" } });
    if (raced) return raced;
    throw error;
  }
}
