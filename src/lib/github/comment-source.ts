import {
  BellRing,
  ClipboardList,
  GitFork,
  GitMerge,
  Info,
  MessageCircleQuestion,
  ShieldCheck,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";

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

/**
 * claude-issue-dispatch.yml内のモード（計画・実装・分割・案内）を区別するための新規マーカー
 * （`<!-- issue-deck-agent:<role> -->`）。issue-deck-sourceとは別軸（source＝どのワークフローか、
 * agent＝その中のどの役割か）として併記する。plan-type/qa-answer/fallback-noticeで既に一意に
 * 判別できるロール（planner/splitter（計画確定分）/responder/error-notifier）には付与しない。
 */
export const COMMENT_AGENT_MARKER_ROLES = ["implementer", "splitter", "guide"] as const;

export type CommentAgentMarkerRole = (typeof COMMENT_AGENT_MARKER_ROLES)[number];

const AGENT_MARKER_PATTERN = /<!-- issue-deck-agent:(implementer|splitter|guide) -->/;

/** 指定したコメントからissue-deck-agentマーカーの役割を読み取る。マーカーが無ければnull */
export function extractAgentMarker(
  comment: Pick<IssueComment, "body">,
): CommentAgentMarkerRole | null {
  const match = comment.body.match(AGENT_MARKER_PATTERN);
  return match ? (match[1] as CommentAgentMarkerRole) : null;
}

/**
 * 各種マーカー導入前に投稿された過去コメント向けの、書き出しの絵文字からの役割フォールバック推測。
 * マーカーが一切見つからなかった場合にのみ最後の手段として使う。
 */
const EMOJI_ROLE_FALLBACK: ReadonlyArray<readonly [string, CommentAgentRole]> = [
  ["🔍", "planner"],
  ["🔧", "implementer"],
  ["🔀", "splitter"],
  ["ℹ️", "guide"],
];

function extractEmojiRoleFallback(body: string): CommentAgentRole | null {
  const trimmed = body.trimStart();
  const found = EMOJI_ROLE_FALLBACK.find(([emoji]) => trimmed.startsWith(emoji));
  return found ? found[1] : null;
}

export type ResolvedCommentSource =
  | { kind: "fallback-notice" }
  | { kind: "qa-answer" }
  | { kind: "plan"; planType: PlanType }
  | { kind: "agent"; role: CommentAgentMarkerRole }
  | { kind: "source"; id: CommentSourceId }
  | { kind: "emoji-fallback"; role: CommentAgentRole }
  | { kind: "unknown-automation" };

/**
 * コメント本文と投稿者のlogin名から、UIに表示するボット役割の解決に使う中間結果を返す。
 * 優先順位: フォールバック通知 → 質問への回答 → 計画 → issue-deck-agentの役割 →
 * issue-deck-sourceのid → 書き出しの絵文字によるフォールバック推測 →
 * （botログインだが該当無し）不明な自動投稿 → （bot以外）null（役割なし）
 */
export function resolveCommentSource(
  comment: Pick<IssueComment, "body">,
  login: string,
): ResolvedCommentSource | null {
  if (isFallbackNoticeComment(comment)) return { kind: "fallback-notice" };
  if (isQaAnswerComment(comment)) return { kind: "qa-answer" };
  const planType = extractPlanType(comment);
  if (planType) return { kind: "plan", planType };
  const agentRole = extractAgentMarker(comment);
  if (agentRole) return { kind: "agent", role: agentRole };
  const sourceId = extractCommentSourceId(comment);
  if (sourceId) return { kind: "source", id: sourceId };
  const emojiRole = extractEmojiRoleFallback(comment.body);
  if (emojiRole) return { kind: "emoji-fallback", role: emojiRole };
  if (isBotLogin(login)) return { kind: "unknown-automation" };
  return null;
}

/** ボットの役割。issue-deckのマルチエージェント運用における各ワークフロー・モードに対応する */
export type CommentAgentRole =
  | "planner"
  | "splitter"
  | "implementer"
  | "responder"
  | "guide"
  | "reviewer"
  | "conflict-resolver"
  | "notifier"
  | "error-notifier";

/**
 * issue-deck-sourceのidのうち、そのidだけで役割が一意に決まるもの（claude-issue-dispatchは
 * 計画・実装・分割・案内が同居するため対象外。issue-deck-agentマーカーまたは絵文字フォール
 * バックで判別する）。
 */
const SOURCE_ID_ROLES: Partial<Record<CommentSourceId, CommentAgentRole>> = {
  "claude-review-develop": "reviewer",
  "claude-conflict-resolve": "conflict-resolver",
  "issue-labels": "notifier",
};

/** resolveCommentSource()の結果からボットの役割を導く。役割を特定できない場合はnull（汎用ボット扱い） */
export function commentAgentRole(resolved: ResolvedCommentSource): CommentAgentRole | null {
  switch (resolved.kind) {
    case "fallback-notice":
      return "error-notifier";
    case "qa-answer":
      return "responder";
    case "plan":
      return resolved.planType === "split" ? "splitter" : "planner";
    case "agent":
      return resolved.role;
    case "source":
      return SOURCE_ID_ROLES[resolved.id] ?? null;
    case "emoji-fallback":
      return resolved.role;
    case "unknown-automation":
      return null;
  }
}

export type CommentAgentProfile = {
  /** ヘッダ・アバターのaltテキストに使う役割の表示名（例: 「計画ボット」） */
  label: string;
  icon: LucideIcon;
  /** アバターの背景色（16進カラーコード） */
  avatarColor: string;
  /** ヘッダの役割名の文字色（Tailwindクラス） */
  textClassName: string;
  /** 吹き出しの縁取り・背景の薄い帯（Tailwindクラス） */
  bubbleClassName: string;
};

export const COMMENT_AGENT_PROFILES: Record<CommentAgentRole, CommentAgentProfile> = {
  planner: {
    label: "計画ボット",
    icon: ClipboardList,
    avatarColor: "#f59e0b",
    textClassName: "text-amber-600 dark:text-amber-400",
    bubbleClassName: "border-amber-500/30 bg-amber-500/5",
  },
  splitter: {
    label: "分割ボット",
    icon: GitFork,
    avatarColor: "#06b6d4",
    textClassName: "text-cyan-600 dark:text-cyan-400",
    bubbleClassName: "border-cyan-500/30 bg-cyan-500/5",
  },
  implementer: {
    label: "実装ボット",
    icon: Wrench,
    avatarColor: "#10b981",
    textClassName: "text-emerald-600 dark:text-emerald-400",
    bubbleClassName: "border-emerald-500/30 bg-emerald-500/5",
  },
  responder: {
    label: "回答ボット",
    icon: MessageCircleQuestion,
    avatarColor: "#8b5cf6",
    textClassName: "text-violet-600 dark:text-violet-400",
    bubbleClassName: "border-violet-500/40 bg-violet-500/5",
  },
  guide: {
    label: "案内ボット",
    icon: Info,
    avatarColor: "#64748b",
    textClassName: "text-slate-600 dark:text-slate-400",
    bubbleClassName: "border-slate-500/30 bg-slate-500/5",
  },
  reviewer: {
    label: "レビューボット",
    icon: ShieldCheck,
    avatarColor: "#6366f1",
    textClassName: "text-indigo-600 dark:text-indigo-400",
    bubbleClassName: "border-indigo-500/30 bg-indigo-500/5",
  },
  "conflict-resolver": {
    label: "コンフリクト解消ボット",
    icon: GitMerge,
    avatarColor: "#f97316",
    textClassName: "text-orange-600 dark:text-orange-400",
    bubbleClassName: "border-orange-500/30 bg-orange-500/5",
  },
  notifier: {
    label: "進捗通知ボット",
    icon: BellRing,
    avatarColor: "#0ea5e9",
    textClassName: "text-sky-600 dark:text-sky-400",
    bubbleClassName: "border-sky-500/30 bg-sky-500/5",
  },
  "error-notifier": {
    label: "エラー通知ボット",
    icon: TriangleAlert,
    avatarColor: "#ef4444",
    textClassName: "text-red-600 dark:text-red-400",
    bubbleClassName: "border-red-500/30 bg-red-500/5",
  },
};
