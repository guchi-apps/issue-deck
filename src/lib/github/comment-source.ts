import type { IssueComment } from "@/types/issue";
import { isQaAnswerComment } from "@/lib/github/ask-claude";
import { isFallbackNoticeComment } from "@/lib/github/fallback-notice";
import { isBotLogin } from "@/lib/github/is-bot-login";

/**
 * claude-issue-dispatch.ymlが計画コメントの末尾に付与するマーカー
 * （`<!-- issue-deck-plan-type:implement|split -->`）から読み取れる計画種別。
 * これまでワークフロー内のbash（`grep -oP`）でのみ判定しておりTS側の判定関数が
 * 無かったため、UI表示用に新設する。
 */
export type PlanType = "implement" | "split";

const PLAN_TYPE_MARKER_PATTERN = /<!-- issue-deck-plan-type:(implement|split) -->/;

/** 指定したコメントから計画種別マーカーを読み取る。マーカーが無ければnull */
export function extractPlanType(comment: Pick<IssueComment, "body">): PlanType | null {
  const match = comment.body.match(PLAN_TYPE_MARKER_PATTERN);
  return match ? (match[1] as PlanType) : null;
}

/**
 * plan-type/qa-answer/fallback-noticeのような専用マーカーを持たない定型コメントの
 * 投稿元ワークフローを示すマーカー（`<!-- issue-deck-source:<id> -->`）のid一覧。
 * claude-issue-dispatch以外は他のサブIssueで実際にワークフローへ適用する想定のため、
 * 判定関数側のみ先に用意する。
 */
export const COMMENT_SOURCE_IDS = [
  "claude-issue-dispatch",
  "claude-review-develop",
  "claude-conflict-resolve",
  "issue-labels",
] as const;

export type CommentSourceId = (typeof COMMENT_SOURCE_IDS)[number];

function commentSourceMarker(id: CommentSourceId): string {
  return `<!-- issue-deck-source:${id} -->`;
}

/** 指定したコメントからissue-deck-sourceマーカーのidを読み取る。マーカーが無ければnull */
export function extractCommentSourceId(
  comment: Pick<IssueComment, "body">,
): CommentSourceId | null {
  return COMMENT_SOURCE_IDS.find((id) => comment.body.includes(commentSourceMarker(id))) ?? null;
}

export type ResolvedCommentSource =
  | { kind: "fallback-notice" }
  | { kind: "qa-answer" }
  | { kind: "plan"; planType: PlanType }
  | { kind: "source"; id: CommentSourceId }
  | { kind: "unknown-automation" };

/**
 * コメント本文と投稿者のlogin名から、UIに表示する投稿元バッジの内容を解決する。
 * 優先順位: フォールバック通知 → 質問への回答 → 計画 → issue-deck-sourceのid →
 * （botログインだが該当マーカー無し）不明な自動投稿 → （bot以外）null（バッジなし）
 */
export function resolveCommentSource(
  comment: Pick<IssueComment, "body">,
  login: string,
): ResolvedCommentSource | null {
  if (isFallbackNoticeComment(comment)) return { kind: "fallback-notice" };
  if (isQaAnswerComment(comment)) return { kind: "qa-answer" };
  const planType = extractPlanType(comment);
  if (planType) return { kind: "plan", planType };
  const sourceId = extractCommentSourceId(comment);
  if (sourceId) return { kind: "source", id: sourceId };
  if (isBotLogin(login)) return { kind: "unknown-automation" };
  return null;
}

const COMMENT_SOURCE_ID_LABELS: Record<CommentSourceId, string> = {
  "claude-issue-dispatch": "Claude Code",
  "claude-review-develop": "Claude Code",
  "claude-conflict-resolve": "Claude Code",
  "issue-labels": "自動処理",
};

/** resolveCommentSource()の結果からUI表示用のラベル文字列を組み立てる */
export function commentSourceLabel(resolved: ResolvedCommentSource): string {
  switch (resolved.kind) {
    case "fallback-notice":
      return "自動処理（エラー通知）";
    case "qa-answer":
      return "Claude Code";
    case "plan":
      return resolved.planType === "split" ? "Claude Code（分割計画）" : "Claude Code（計画）";
    case "source":
      return COMMENT_SOURCE_ID_LABELS[resolved.id];
    case "unknown-automation":
      return "不明な自動投稿";
  }
}
