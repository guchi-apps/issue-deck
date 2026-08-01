import { formatRelativeDate } from "@/lib/format-relative-date";
import type { GithubApiComment, GithubApiIssue } from "@/lib/github/issues-api";
import type { Issue, IssueComment, IssueLabel } from "@/types/issue";
import type {
  Issue as DbIssue,
  IssueLabel as DbIssueLabel,
} from "@prisma/client";

type RepositoryRef = {
  fullName: string;
  private: boolean;
  archived: boolean;
};

function mapLabel(label: { name: string; color: string } | string): IssueLabel {
  if (typeof label === "string") {
    return { name: label, color: "#64748b" };
  }
  return { name: label.name, color: `#${label.color}` };
}

export function mapIssue(repository: RepositoryRef, raw: GithubApiIssue): Issue {
  const milestone = raw.milestone
    ? {
        name: raw.milestone.title,
        progressPercent:
          raw.milestone.open_issues + raw.milestone.closed_issues === 0
            ? 0
            : Math.round(
                (raw.milestone.closed_issues /
                  (raw.milestone.open_issues + raw.milestone.closed_issues)) *
                  100,
              ),
      }
    : null;

  return {
    id: String(raw.id),
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    repositoryFullName: repository.fullName,
    repositoryPrivate: repository.private,
    repositoryArchived: repository.archived,
    author: { login: raw.user?.login ?? "unknown" },
    assignee: raw.assignee ? { login: raw.assignee.login } : null,
    labels: raw.labels.map(mapLabel),
    milestone,
    commentCount: raw.comments,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    htmlUrl: raw.html_url,
    favorite: false,
  };
}

export function dbIssueToDisplayIssue(
  repository: RepositoryRef,
  row: DbIssue & { labels: DbIssueLabel[] },
): Issue {
  const milestone =
    row.milestoneTitle && row.milestoneOpen !== null && row.milestoneClosed !== null
      ? {
          name: row.milestoneTitle,
          progressPercent:
            row.milestoneOpen + row.milestoneClosed === 0
              ? 0
              : Math.round((row.milestoneClosed / (row.milestoneOpen + row.milestoneClosed)) * 100),
        }
      : null;

  return {
    id: String(row.githubIssueId),
    number: row.number,
    title: row.title,
    body: row.body ?? "",
    state: row.state === "OPEN" ? "open" : "closed",
    repositoryFullName: repository.fullName,
    repositoryPrivate: repository.private,
    repositoryArchived: repository.archived,
    author: { login: row.authorLogin },
    assignee: row.assigneeLogin ? { login: row.assigneeLogin } : null,
    labels: row.labels.map((label) => ({ name: label.name, color: `#${label.color}` })),
    milestone,
    commentCount: row.commentCount,
    createdAt: row.githubCreatedAt.toISOString(),
    updatedAt: row.githubUpdatedAt.toISOString(),
    htmlUrl: row.htmlUrl,
    favorite: false,
  };
}

export function mapComment(raw: GithubApiComment): IssueComment {
  return {
    id: String(raw.id),
    author: { login: raw.user?.login ?? "unknown" },
    createdAtLabel: formatRelativeDate(raw.created_at),
    body: raw.body ?? "",
    reactionCount: raw.reactions?.["+1"] ?? 0,
  };
}
