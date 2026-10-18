import { BadgeCheck, Bot, CircleDashed, CircleSlash, Hand, Hourglass, Search, TriangleAlert } from "lucide-react";

import {
  countAchievedCriteria,
  parseIssueWorkSummary,
  type WorkStatus,
} from "@/lib/issue-work-summary";
import { cn } from "@/lib/utils";

/**
 * 通常Issueと旧手作業Issueで共通の「作業サマリー」（#4524）。
 *
 * 先頭に出すのは現在地・目的・完了条件だけ。**通常Issueの簡素な詳細を基準に**し、使わない
 * ものは出さない（手順・担当の一覧や実施記録は、各画面の閉じた「補足」に置く）。
 * amberは「あなたの操作待ち」（`00.check-user`）だけ、依存待ちは青で別の状態として出す。
 */
export const WORK_STATUS_VIEW: Record<
  WorkStatus,
  { label: string; tone: "attention" | "wait" | "ai" | "danger" | "success" | "muted"; Icon: typeof Bot }
> = {
  running: { label: "AIが作業中・操作不要", tone: "ai", Icon: Bot },
  dependency_wait: { label: "依存先を待っています・操作不要", tone: "wait", Icon: Hourglass },
  user_action: { label: "あなたの操作を待っています", tone: "attention", Icon: Hand },
  ai_verifying: { label: "AIが確認中・操作不要", tone: "ai", Icon: Search },
  failed: { label: "完了検証が成功していません", tone: "danger", Icon: TriangleAlert },
  done: { label: "完了", tone: "success", Icon: BadgeCheck },
  closed: { label: "クローズ済み・完了検証なし", tone: "muted", Icon: CircleSlash },
  idle: { label: "未着手", tone: "muted", Icon: CircleDashed },
};

const PILL_VAR = {
  attention: "[--pill:var(--color-amber-700)] dark:[--pill:var(--color-amber-300)]",
  wait: "[--pill:var(--color-sky-700)] dark:[--pill:var(--color-sky-300)]",
  ai: "[--pill:var(--color-violet-700)] dark:[--pill:var(--color-violet-300)]",
  danger: "[--pill:var(--destructive)]",
  success: "[--pill:var(--color-emerald-700)] dark:[--pill:var(--color-emerald-300)]",
  muted: "[--pill:var(--muted-foreground)]",
} as const;

const CARD_BORDER = {
  attention: "border-l-amber-500",
  wait: "border-l-sky-500",
  ai: "border-l-violet-500",
  danger: "border-l-destructive",
  success: "border-l-emerald-500",
  muted: "border-l-border",
} as const;

/** 状態カードの左線と、ピルの色変数（amber＝あなたの操作待ち、sky＝依存待ち、violet＝AI） */
export const WORK_TONE_CLASS = Object.fromEntries(
  (Object.keys(PILL_VAR) as (keyof typeof PILL_VAR)[]).map((k) => [k, `${CARD_BORDER[k]} ${PILL_VAR[k]}`]),
) as Record<keyof typeof PILL_VAR, string>;

export function WorkStatusPill({ status, label }: { status: WorkStatus; label?: string }) {
  const view = WORK_STATUS_VIEW[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-current px-2 py-px text-xs font-semibold text-[var(--pill)]",
        PILL_VAR[view.tone],
      )}
    >
      <view.Icon className="size-3.5" aria-hidden />
      {label ?? view.label}
    </span>
  );
}

/** 目的と完了条件。本文に見出しが無ければ「記載なし」とだけ言い、条件を作らない */
export function WorkPurposeAndCriteria({
  body,
  verificationPassed,
  purposeFallback,
  idPrefix,
}: {
  body: string | null | undefined;
  /** 手作業の完了検証がすべて成功した（検証結果で達成を数える条件に使う） */
  verificationPassed: boolean;
  /** 本文に目的が無いときの代わり（セッションの事前調査の目的） */
  purposeFallback?: string | null;
  idPrefix: string;
}) {
  const source = parseIssueWorkSummary(body);
  const purpose = source.purpose ?? purposeFallback ?? null;
  const { achieved, total } = countAchievedCriteria(source, verificationPassed);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <h4 className="text-[11px] font-bold tracking-wider text-muted-foreground">目的</h4>
        <p className="mt-0.5 break-words text-sm">{purpose ?? <span className="text-muted-foreground">記載なし</span>}</p>
      </div>
      <div>
        <h4 id={`${idPrefix}-criteria`} className="text-[11px] font-bold tracking-wider text-muted-foreground">
          完了条件{total > 0 && `（${achieved}/${total}）`}
        </h4>
        {total === 0 ? (
          <p className="mt-0.5 text-sm text-muted-foreground">記載なし</p>
        ) : (
          <ul aria-labelledby={`${idPrefix}-criteria`} className="mt-1 flex flex-col gap-1.5 text-sm">
            {source.criteria.map((c, i) => {
              const done = c.checked === null ? verificationPassed : c.checked;
              return (
                <li key={`${i}:${c.text}`} className="flex min-w-0 items-start gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1 grid size-4 shrink-0 place-items-center rounded border text-[10px] leading-none",
                      done ? "border-emerald-600 bg-emerald-600 text-white" : "border-dashed text-transparent",
                    )}
                  >
                    ✓
                  </span>
                  <span className="min-w-0 break-words">
                    <span className="sr-only">{done ? "達成：" : "未達成："}</span>
                    {c.text}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * 手作業Issue以外の詳細に出す作業サマリー。目的も完了条件も本文に無く、状態も出すものが
 * 無ければ何も描かない。
 */
export function IssueWorkSummary({
  body,
  status,
  blockingMessage,
  idPrefix,
  className,
}: {
  body: string | null | undefined;
  status: WorkStatus;
  /** 依存待ちの理由（待っている相手と状況の1行） */
  blockingMessage?: string | null;
  idPrefix: string;
  className?: string;
}) {
  const source = parseIssueWorkSummary(body);
  const showStatus = status === "dependency_wait";
  if (!source.purpose && source.criteria.length === 0 && !showStatus) return null;
  return (
    <section
      className={cn("rounded-md border bg-background p-3", className)}
      aria-label="作業サマリー"
      data-work-status={status}
    >
      {showStatus && (
        <div className="mb-2">
          <WorkStatusPill status={status} />
          {blockingMessage && <p className="mt-1 text-xs text-muted-foreground">{blockingMessage}</p>}
        </div>
      )}
      <WorkPurposeAndCriteria body={body} verificationPassed={false} idPrefix={idPrefix} />
    </section>
  );
}
