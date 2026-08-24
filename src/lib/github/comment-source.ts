import {
  BellRing,
  ClipboardList,
  GitFork,
  GitMerge,
  Hammer,
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
  "claude-ci-fix",
  "issue-labels",
  // カンバンのStatus変更を受けてissue-deckが投稿する起動コメント（#991 Phase 3）
  "project-status-dispatch",
  // developへのマージ後に取り残された進捗を回収する巡回（#2294）。`issue-labels`の
  // `develop-merge-sweep`ジョブが投稿していたものを、issue-deck側の巡回へ移した先
  "progress-sweep",
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
 * agent＝その中のどの役割か）として併記する。
 *
 * 無人実行では、plan-type/qa-answer/fallback-noticeで既に一意に判別できるロールに重ねて
 * 付与する必要はない。一方、**ローカル（サブPC）セッションはこのマーカーだけが手掛かりになる**。
 * `gh`がユーザー本人のトークンで動くためlogin名が人間と同じになり、マーカーが無いと画面上
 * ボットの発言と本人の発言を区別できないため（#1346）、計画は`planner`、レビュー・統合は
 * `reviewer`を明示的に付ける（`scripts/prompts/`の各プロンプト）。
 */
export const COMMENT_AGENT_MARKER_ROLES = [
  "planner",
  "implementer",
  "splitter",
  "guide",
  "reviewer",
] as const;

export type CommentAgentMarkerRole = (typeof COMMENT_AGENT_MARKER_ROLES)[number];

// 役割を足したときに正規表現の更新を忘れないよう、一覧から組み立てる
const AGENT_MARKER_PATTERN = new RegExp(
  `<!-- issue-deck-agent:(${COMMENT_AGENT_MARKER_ROLES.join("|")}) -->`,
);

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
  | "ci-fixer"
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
  "claude-ci-fix": "ci-fixer",
  "issue-labels": "notifier",
  "progress-sweep": "notifier",
  // project-status-dispatchは意図的に割り当てない。カンバンのStatus変更で起動した
  // コメントは、issue-mapper.tsが投稿者マーカーから操作者本人へ寄せて表示するため
  // （ボタン経由の起動と同じ見た目にする。#1026）、ボットの役割を持たせるとボット名と
  // 投稿者名が食い違う
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

/**
 * 本文のマーカーだけで「人ではなく自動投稿である」と断定できるコメントかどうか。
 *
 * ローカル（サブPC）セッションのClaude Codeは`gh`がユーザー本人のトークンを使うため、
 * 投稿者のlogin名では本人の発言と区別できない。login名を見ずに本文だけで判定するのが
 * この関数で、画面はこれを使って自分の名義のコメントでもボットの吹き出し（左寄せ）で
 * 表示する（#1346）。
 *
 * **断定に使うのはマーカーが明示された種別だけ**で、書き出しの絵文字による推測
 * （`emoji-fallback`）とlogin名に依存する`unknown-automation`は含めない。前者を含めると、
 * ユーザー本人が🔧などで書き始めたコメントまでボット扱いになる。
 *
 * カンバンのドラッグ起点の起動コメント（`issue-deck-source:project-status-dispatch`）は
 * 役割を持たず、実際に操作した人間へ寄せて表示する（#1026）ため、ここでもfalseになる。
 */
export function isMarkedAutomationComment(resolved: ResolvedCommentSource | null): boolean {
  if (!resolved) return false;
  switch (resolved.kind) {
    case "fallback-notice":
    case "qa-answer":
    case "plan":
    case "agent":
      return true;
    case "source":
      return SOURCE_ID_ROLES[resolved.id] != null;
    case "emoji-fallback":
    case "unknown-automation":
      return false;
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
  "ci-fixer": {
    label: "CI修正ボット",
    icon: Hammer,
    avatarColor: "#14b8a6",
    textClassName: "text-teal-600 dark:text-teal-400",
    bubbleClassName: "border-teal-500/30 bg-teal-500/5",
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
