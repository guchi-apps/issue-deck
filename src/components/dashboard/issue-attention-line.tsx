import {
  AlertTriangle,
  CalendarClock,
  CircleDashed,
  Hourglass,
  Link2,
  Loader2,
  Lock,
  MessageCircleQuestion,
  GitMerge,
  ScrollText,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  IssueAttention,
  IssueAttentionKind,
  IssueAttentionTone,
} from "@/lib/issue-attention-state";

/**
 * Issueの代表状態と次の行動を1行で見せる共通部品（#4425）。
 *
 * Issue一覧の行・Issue詳細（PC・スマホ）が同じ部品を使い、状態・理由・操作可否を一致させる。
 * 判定は`resolveIssueAttention`にあり、ここは描くだけ。色だけで状態を伝えないよう、
 * アイコンと日本語を併用する。#4426〜#4428の画面でも再利用する。
 */
const ICONS: Record<IssueAttentionKind, typeof Lock> = {
  permission: Lock,
  question: MessageCircleQuestion,
  plan: ScrollText,
  merge: GitMerge,
  "plan-review-creating": Loader2,
  error: AlertTriangle,
  dependency: Link2,
  reserved: CalendarClock,
  running: Loader2,
  queued: Hourglass,
  "not-started": CircleDashed,
};

const TONE_CLASS: Record<IssueAttentionTone, string> = {
  "needs-user": "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  blocked: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  error: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  idle: "bg-muted text-muted-foreground",
};

export function IssueAttentionLine({
  attention,
  className,
  compact = false,
}: {
  attention: IssueAttention;
  className?: string;
  /** 一覧の行など、次の行動を1〜2行に収めたいとき */
  compact?: boolean;
}) {
  const Icon = ICONS[attention.kind];
  return (
    <div
      data-attention-kind={attention.kind}
      className={cn("flex min-w-0 items-start gap-2 text-xs", className)}
    >
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-semibold",
          TONE_CLASS[attention.tone],
        )}
      >
        <Icon
          className={cn(
            "size-3.5",
            (attention.kind === "running" || attention.kind === "plan-review-creating") &&
              "animate-spin motion-reduce:animate-none",
          )}
          aria-hidden
        />
        {attention.label}
      </span>
      <span className={cn("min-w-0 break-words text-foreground", compact && "line-clamp-2")}>
        {attention.nextAction}
      </span>
    </div>
  );
}
