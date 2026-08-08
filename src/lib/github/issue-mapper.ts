import { formatRelativeDate } from "@/lib/format-relative-date";
import type { GithubApiComment, GithubApiIssue } from "@/lib/github/issues-api";
import type { Issue, IssueComment, IssueLabel, IssueStateReason } from "@/types/issue";
import type {
  Issue as DbIssue,
  IssueLabel as DbIssueLabel,
  IssueStateReason as DbIssueStateReason,
} from "@prisma/client";

type RepositoryRef = {
  fullName: string;
  private: boolean;
  archived: boolean;
};

// POST /api/issues/comments (src/app/api/issues/comments/route.ts) が投稿者識別用に
// 本文末尾へ埋め込む不可視マーカー。GitHub上のコメント投稿者は常にissue-deckの
// GitHub App(issue-deck[bot])になるため、.github/workflows/claude-issue-dispatch.yml が
// 実際に操作した人間のwrite権限を検証できるようにするためのもの。アプリ画面上には
// 表示したくないため、取得時に取り除く。
const POSTER_MARKER_PATTERN = /\n\n<!-- issue-deck:posted-by:\S+ -->$/;

function stripPosterMarker(body: string): string {
  return body.replace(POSTER_MARKER_PATTERN, "");
}

function mapDbStateReason(stateReason: DbIssueStateReason | null): IssueStateReason {
  switch (stateReason) {
    case "COMPLETED":
      return "completed";
    case "NOT_PLANNED":
      return "not_planned";
    case "REOPENED":
      return "reopened";
    default:
      return null;
  }
}

function mapLabel(
  label: { name: string; color: string; description: string | null } | string,
): IssueLabel {
  if (typeof label === "string") {
    return { name: label, color: "#64748b", description: null };
  }
  return { name: label.name, color: `#${label.color}`, description: label.description };
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
    stateReason: raw.state_reason ?? null,
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
    closedAt: raw.closed_at ?? null,
    checkUserLabeledAt: null,
    lastCommentAt: null,
    htmlUrl: raw.html_url,
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    deployCheckStatus: null,
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
    stateReason: mapDbStateReason(row.stateReason),
    repositoryFullName: repository.fullName,
    repositoryPrivate: repository.private,
    repositoryArchived: repository.archived,
    author: { login: row.authorLogin },
    assignee: row.assigneeLogin ? { login: row.assigneeLogin } : null,
    labels: row.labels.map((label) => ({
      name: label.name,
      color: `#${label.color}`,
      description: label.description,
    })),
    milestone,
    commentCount: row.commentCount,
    createdAt: row.githubCreatedAt.toISOString(),
    updatedAt: row.githubUpdatedAt.toISOString(),
    closedAt: row.githubClosedAt?.toISOString() ?? null,
    checkUserLabeledAt: row.checkUserLabeledAt?.toISOString() ?? null,
    lastCommentAt: row.lastCommentAt?.toISOString() ?? null,
    htmlUrl: row.htmlUrl,
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    deployCheckStatus: null,
  };
}

export function mapComment(raw: GithubApiComment): IssueComment {
  return {
    id: String(raw.id),
    author: { login: raw.user?.login ?? "unknown" },
    createdAtLabel: formatRelativeDate(raw.created_at),
    body: stripPosterMarker(raw.body ?? ""),
    reactionCount: raw.reactions?.["+1"] ?? 0,
  };
}
