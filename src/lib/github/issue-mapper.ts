import { formatRelativeDate } from "@/lib/format-relative-date";
import { isBotComment } from "@/lib/github/is-bot-comment";
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

// issue-deckのGitHub App名義で投稿するコメントに、実際に操作した人間を記録する不可視マーカー。
// 現在の発行元はカンバンのStatus変更を受けて投稿する起動コメント
// (src/lib/github/project-status-dispatch.tsのdispatchCommentBody。#991 Phase 3)。
// reusable-issue-dispatch.ymlが、Bot名義のコメントから実際の操作者を復元してwrite権限を
// 検証するために読む。アプリ画面上には表示したくないため取得時に取り除き、
// 表示上の投稿者もこのマーカーから解決する(resolveCommentAuthorLogin)。
//
// 画面のコメント欄からの投稿(POST /api/issues/comments)は個人のOAuthトークンで行うため
// 投稿者がそもそも人間になり、このマーカーは付かない。
const POSTER_MARKER_PATTERN = /\n\n<!-- issue-deck:posted-by:(\S+) -->$/;

function stripPosterMarker(body: string): string {
  return body.replace(POSTER_MARKER_PATTERN, "");
}

/**
 * 表示上の投稿者を決める。
 *
 * カンバンのStatus変更で起動したコメント（#991 Phase 3）はGitHub上issue-deckのGitHub App名義に
 * なるが、**実際に操作したのはマーカーに記録された人間**である。同じ内容を「実装を開始」ボタン
 * から投稿した場合は本人名義になるため、起動経路で見た目が変わらないよう人間へ寄せる。
 *
 * **マーカーを信用するのは、GitHub上の投稿者がissue-deck自身のGitHub Appである場合に限る。**
 * パブリックリポジトリでは誰でも本文末尾に偽のマーカーを付けられるため、これが無いと
 * 任意の人物になりすませてしまう。`reusable-issue-dispatch.yml`が権限確認で行っている
 * `[ "$ACTOR" = "issue-deck[bot]" ]`と同じ方針。
 */
function resolveCommentAuthorLogin(body: string, login: string): string {
  if (!isBotComment(login)) return login;
  return body.match(POSTER_MARKER_PATTERN)?.[1] ?? login;
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
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    projectStatus: null,
    htmlUrl: raw.html_url,
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
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
    qaAnswerPendingAt: row.qaAnswerPendingAt?.toISOString() ?? null,
    lastCommentAt: row.lastCommentAt?.toISOString() ?? null,
    projectStatus: row.projectStatus,
    htmlUrl: row.htmlUrl,
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
  };
}

export function mapComment(raw: GithubApiComment): IssueComment {
  const body = raw.body ?? "";
  const login = raw.user?.login ?? "unknown";
  return {
    id: String(raw.id),
    author: { login: resolveCommentAuthorLogin(body, login) },
    createdAtLabel: formatRelativeDate(raw.created_at),
    body: stripPosterMarker(body),
    reactionCount: raw.reactions?.["+1"] ?? 0,
  };
}
