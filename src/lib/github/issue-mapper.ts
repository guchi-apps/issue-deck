import { formatRelativeDate } from "@/lib/format-relative-date";
import type { GithubApiComment, GithubApiIssue } from "@/lib/github/issues-api";
import type { Issue, IssueComment, IssueLabel } from "@/types/issue";

function mapLabel(label: { name: string; color: string } | string): IssueLabel {
  if (typeof label === "string") {
    return { name: label, color: "#64748b" };
  }
  return { name: label.name, color: `#${label.color}` };
}

export function mapIssue(repositoryFullName: string, raw: GithubApiIssue): Issue {
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
    repositoryFullName,
    author: { login: raw.user?.login ?? "unknown" },
    assignee: raw.assignee ? { login: raw.assignee.login } : null,
    labels: raw.labels.map(mapLabel),
    milestone,
    commentCount: raw.comments,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    htmlUrl: raw.html_url,
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
