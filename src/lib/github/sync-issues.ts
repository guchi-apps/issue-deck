import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { CHECK_USER_LABEL } from "@/lib/github/approval-labels";
import { isAskClaudeQuestionComment, isQaAnswerComment } from "@/lib/github/ask-claude";
import { dbIssueToDisplayIssue } from "@/lib/github/issue-mapper";
import type { GithubApiIssue } from "@/lib/github/issues-api";
import { fetchIssuesForRepo } from "@/lib/github/issues-api";
import type { Issue } from "@/types/issue";
import type { IssueState, IssueStateReason } from "@prisma/client";

type RepoForSync = {
  id: string;
  ownerLogin: string;
  name: string;
  installation: { installationId: number };
};

function mapLabelName(label: { name: string; color: string } | string): string {
  return typeof label === "string" ? label : label.name;
}

function mapLabelColor(label: { name: string; color: string } | string): string {
  return typeof label === "string" ? "64748b" : label.color;
}

function mapLabelId(label: { id: number } | string): bigint | null {
  return typeof label === "string" ? null : BigInt(label.id);
}

function mapLabelDescription(label: { description: string | null } | string): string | null {
  return typeof label === "string" ? null : label.description;
}

function toIssueState(state: "open" | "closed"): IssueState {
  return state === "open" ? "OPEN" : "CLOSED";
}

function toIssueStateReason(
  stateReason: GithubApiIssue["state_reason"],
): IssueStateReason | null {
  switch (stateReason) {
    case "completed":
      return "COMPLETED";
    case "not_planned":
      return "NOT_PLANNED";
    case "reopened":
      return "REOPENED";
    default:
      return null;
  }
}

async function upsertIssueRow(
  repositoryId: string,
  raw: GithubApiIssue,
  commentCreatedAt?: Date,
) {
  const githubUpdatedAt = new Date(raw.updated_at);

  const existing = await db.issue.findUnique({
    where: { githubIssueId: BigInt(raw.id) },
    include: { labels: true },
  });
  if (existing && existing.githubUpdatedAt > githubUpdatedAt) {
    // Webhookの配信順序はGitHub側で保証されないため、既に反映済みより古いペイロードは無視する
    // （新しいラベル状態が古い状態で上書きされるのを防ぐ）。
    return existing;
  }

  // 「確認待ちフィルターを実際のコメント投稿日時順に並べる」ための基準時刻。
  // issue_comment Webhook（action=created）から渡された投稿日時を、既存の記録値より
  // 新しい場合のみ採用する（配信順序が前後しても新しい方を優先するガード）
  const lastCommentAt =
    commentCreatedAt && (!existing?.lastCommentAt || commentCreatedAt > existing.lastCommentAt)
      ? commentCreatedAt
      : existing?.lastCommentAt ?? null;

  // 「確認待ちフィルターを確認が古い順に並べる」ための基準時刻。00.check-userが新たに
  // 付与された瞬間をcheckUserLabeledAtとして記録し、外れたらnullに戻す。既存Issueで
  // 付与状態が変わらない場合は記録済みの日時を維持する
  const hasCheckUserLabel = raw.labels.some((label) => mapLabelName(label) === CHECK_USER_LABEL);
  const hadCheckUserLabel =
    existing?.labels.some((label) => label.name === CHECK_USER_LABEL) ?? false;
  const checkUserLabeledAt = !hasCheckUserLabel
    ? null
    : hadCheckUserLabel
      ? existing?.checkUserLabeledAt ?? new Date()
      : new Date();

  const data = {
    repositoryId,
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: toIssueState(raw.state),
    stateReason: toIssueStateReason(raw.state_reason),
    htmlUrl: raw.html_url,
    authorLogin: raw.user?.login ?? "unknown",
    assigneeLogin: raw.assignee?.login ?? null,
    commentCount: raw.comments,
    milestoneTitle: raw.milestone?.title ?? null,
    milestoneOpen: raw.milestone?.open_issues ?? null,
    milestoneClosed: raw.milestone?.closed_issues ?? null,
    githubCreatedAt: new Date(raw.created_at),
    githubUpdatedAt,
    githubClosedAt: raw.closed_at ? new Date(raw.closed_at) : null,
    syncedAt: new Date(),
    checkUserLabeledAt,
    lastCommentAt,
  };

  const issue = await db.issue.upsert({
    where: { githubIssueId: BigInt(raw.id) },
    create: { githubIssueId: BigInt(raw.id), ...data },
    update: data,
  });

  const labelNames = raw.labels.map(mapLabelName);
  await db.$transaction([
    ...raw.labels.map((label) =>
      db.issueLabel.upsert({
        where: { issueId_name: { issueId: issue.id, name: mapLabelName(label) } },
        create: {
          issueId: issue.id,
          name: mapLabelName(label),
          color: mapLabelColor(label),
          description: mapLabelDescription(label),
          githubLabelId: mapLabelId(label),
        },
        update: {
          color: mapLabelColor(label),
          description: mapLabelDescription(label),
          githubLabelId: mapLabelId(label),
        },
      }),
    ),
    db.issueLabel.deleteMany({
      where: { issueId: issue.id, name: { notIn: labelNames } },
    }),
  ]);

  return issue;
}

export async function syncRepositoryIssues(repository: RepoForSync): Promise<void> {
  const token = await getInstallationToken(repository.installation.installationId);
  const rawIssues = await fetchIssuesForRepo(repository.ownerLogin, repository.name, token);

  for (const raw of rawIssues) {
    await upsertIssueRow(repository.id, raw);
  }

  await db.issue.deleteMany({
    where: {
      repositoryId: repository.id,
      githubIssueId: { notIn: rawIssues.map((raw) => BigInt(raw.id)) },
    },
  });
}

export async function upsertIssueFromWebhookPayload(
  repositoryId: string,
  issuePayload: GithubApiIssue,
  commentCreatedAt?: Date,
): Promise<void> {
  await upsertIssueRow(repositoryId, issuePayload, commentCreatedAt);
}

export async function deleteIssueByGithubId(githubIssueId: number): Promise<void> {
  await db.issue.deleteMany({ where: { githubIssueId: BigInt(githubIssueId) } });
}

/**
 * issue_comment（created）Webhookで届いた新規コメント本文から、質問への回答待ち状態
 * （qaAnswerPendingAt）を更新する。質問コメント（isAskClaudeQuestionComment）なら現在時刻を
 * セットし、回答コメント（isQaAnswerComment）ならnullに戻す。それ以外の通常コメントでは
 * 何もしない（既存の状態を維持する）。
 */
export async function updateQaAnswerPendingState(
  githubIssueId: number,
  commentBody: string,
): Promise<void> {
  if (isAskClaudeQuestionComment({ body: commentBody })) {
    await db.issue.updateMany({
      where: { githubIssueId: BigInt(githubIssueId) },
      data: { qaAnswerPendingAt: new Date() },
    });
    return;
  }
  if (isQaAnswerComment({ body: commentBody })) {
    await db.issue.updateMany({
      where: { githubIssueId: BigInt(githubIssueId) },
      data: { qaAnswerPendingAt: null },
    });
  }
}

export async function upsertIssueAndGetDisplay(
  repository: { id: string; fullName: string; private: boolean; archived: boolean },
  raw: GithubApiIssue,
): Promise<Issue> {
  const issue = await upsertIssueRow(repository.id, raw);
  const row = await db.issue.findUniqueOrThrow({
    where: { id: issue.id },
    include: { labels: true },
  });
  return dbIssueToDisplayIssue(repository, row);
}
