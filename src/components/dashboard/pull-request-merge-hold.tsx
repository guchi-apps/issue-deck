import { cn } from "@/lib/utils";
import {
  deriveAutoMergeOutlook,
  type AutoMergeOutlook,
  type AutoMergeOutlookKind,
} from "@/lib/pull-request-auto-merge-outlook";
import type { MergeHold } from "@/lib/pull-request-merge-hold";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 自動マージの状態と保留理由（#4377）。マージ確認ダイアログが使う（一覧・詳細・ブランチ画面は#4952から
 * `PullRequestMergeHoldNotice`経由で自動マージの見込みの帯を出す）。
 *
 * 理由が確定した保留（`held`）・判定中（`pending`）・判定を読めない（`unknown`）を見た目と文言で
 * 分け、**読めないことを「保留なし」や成功に置き換えない**。保留理由が無いPR（`none`）は何も出さない。
 */
export function MergeHoldNotice({ hold, className }: { hold: MergeHold; className?: string }) {
  if (hold.status === "none") return null;

  if (hold.status === "held") {
    return (
      <div
        data-testid="merge-hold"
        className={cn(
          "rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-900 dark:text-amber-200",
          className,
        )}
      >
        <span className="font-semibold">自動マージ保留</span>
        <ul className="mt-0.5 list-disc pl-4">
          {hold.reasons.map((reason) => (
            <li key={reason.text}>{reason.text}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <p
      data-testid="merge-hold"
      className={cn("rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground", className)}
    >
      {hold.status === "pending" ? "自動マージ判定中：" : "自動マージ判定を確認できません："}
      {hold.note}
    </p>
  );
}

const OUTLOOK_CLASS: Record<AutoMergeOutlookKind, string> = {
  scheduled: "border-green-600/30 bg-green-600/10 text-green-800 dark:text-green-300",
  expected: "border-blue-600/30 bg-blue-600/10 text-blue-800 dark:text-blue-300",
  manual: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
  excluded: "border-dashed text-muted-foreground",
};

const OUTLOOK_MARK: Record<AutoMergeOutlookKind, string> = {
  scheduled: "●",
  expected: "◷",
  manual: "▲",
  excluded: "–",
};

/**
 * 自動マージされるかの帯（#4952）。「予約済み／予定／されません／対象外」を、色に頼らず記号と見出しで出す。
 * 対象外の画面（closed・draft・develop以外へのPR）では何も出さない。
 */
export function AutoMergeOutlookNotice({ outlook, className }: { outlook: AutoMergeOutlook | null; className?: string }) {
  if (!outlook) return null;
  return (
    <p
      data-testid="merge-hold"
      data-outlook={outlook.kind}
      className={cn("flex min-w-0 items-start gap-2 rounded-md border px-2 py-1 text-xs", OUTLOOK_CLASS[outlook.kind], className)}
    >
      <span className="shrink-0 font-semibold whitespace-nowrap">
        <span aria-hidden="true">{OUTLOOK_MARK[outlook.kind]}</span> 自動マージ {outlook.label}
      </span>
      <span className="min-w-0 break-words">{outlook.reason}</span>
    </p>
  );
}

export function PullRequestMergeHoldNotice({
  pullRequest,
  className,
}: {
  pullRequest: PullRequestSummary;
  className?: string;
}) {
  return <AutoMergeOutlookNotice outlook={deriveAutoMergeOutlook(pullRequest)} className={className} />;
}
