import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { dbIssueToDisplayIssue } from "@/lib/github/issue-mapper";
import type { GithubApiIssue } from "@/lib/github/issues-api";
import { fetchIssuesForRepo } from "@/lib/github/issues-api";
import type { Issue } from "@/types/issue";
import type { IssueState } from "@prisma/client";

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

function toIssueState(state: "open" | "closed"): IssueState {
  return state === "open" ? "OPEN" : "CLOSED";
}

async function upsertIssueRow(repositoryId: string, raw: GithubApiIssue) {
  const githubUpdatedAt = new Date(raw.updated_at);

  const existing = await db.issue.findUnique({ where: { githubIssueId: BigInt(raw.id) } });
  if (existing && existing.githubUpdatedAt > githubUpdatedAt) {
    // Webhookの配信順序はGitHub側で保証されないため、既に反映済みより古いペイロードは無視する
    // （新しいラベル状態が古い状態で上書きされるのを防ぐ）。
    return existing;
  }

  const data = {
    repositoryId,
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: toIssueState(raw.state),
    htmlUrl: raw.html_url,
    authorLogin: raw.user?.login ?? "unknown",
    assigneeLogin: raw.assignee?.login ?? null,
    commentCount: raw.comments,
    milestoneTitle: raw.milestone?.title ?? null,
    milestoneOpen: raw.milestone?.open_issues ?? null,
    milestoneClosed: raw.milestone?.closed_issues ?? null,
    githubCreatedAt: new Date(raw.created_at),
    githubUpdatedAt,
    syncedAt: new Date(),
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
          githubLabelId: mapLabelId(label),
        },
        update: { color: mapLabelColor(label), githubLabelId: mapLabelId(label) },
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
): Promise<void> {
  await upsertIssueRow(repositoryId, issuePayload);
}

export async function deleteIssueByGithubId(githubIssueId: number): Promise<void> {
  await db.issue.deleteMany({ where: { githubIssueId: BigInt(githubIssueId) } });
}

export async function upsertIssueAndGetDisplay(
  repositoryFullName: string,
  repositoryId: string,
  raw: GithubApiIssue,
): Promise<Issue> {
  const issue = await upsertIssueRow(repositoryId, raw);
  const row = await db.issue.findUniqueOrThrow({
    where: { id: issue.id },
    include: { labels: true },
  });
  return dbIssueToDisplayIssue(repositoryFullName, row);
}
