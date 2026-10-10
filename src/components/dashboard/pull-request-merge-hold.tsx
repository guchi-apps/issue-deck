import { cn } from "@/lib/utils";
import { deriveMergeHold, type MergeHold } from "@/lib/pull-request-merge-hold";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 自動マージの状態と保留理由（#4377）。一覧・詳細・ブランチ画面・マージ確認ダイアログで共通。
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

export function PullRequestMergeHoldNotice({
  pullRequest,
  className,
}: {
  pullRequest: PullRequestSummary;
  className?: string;
}) {
  return <MergeHoldNotice hold={deriveMergeHold(pullRequest)} className={className} />;
}
