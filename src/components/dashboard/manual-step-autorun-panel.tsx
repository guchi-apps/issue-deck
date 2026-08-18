"use client";

import { Check, Loader2, ShieldCheck, Terminal, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { describeManualStepExecutionRejection } from "@/lib/dispatch/dispatch-job";
import { describeManualStepRunPlan, type ManualStepRunPlan } from "@/lib/manual-step-autorun";
import { MANUAL_STEP_TIMEOUT_SECONDS } from "@/lib/manual-step-command";
import { cn } from "@/lib/utils";

/**
 * 手作業アシスタントの最初の画面に出す、自動実行の承認パネル（#1869）。
 *
 * **押す1回で実行される全文を、押す前に並べる。** 承認の対象は「本文の手順」ではなく
 * 「これから実行される文字列」なので、畳まずに全部出す。代行できない項目もその理由とともに
 * 同じ並びへ出す——飛ばされることが分かっていないと、人が自分で実行する手順を待たずに
 * 次へ進んでしまう。
 *
 * **PC・スマホで同じコンポーネントを使う**（アシスタントの他の部品と同じ方針）。
 */
export function ManualStepAutoRunPanel({
  plan,
  hostName,
  device,
  consent,
  onConsentChange,
  onApprove,
  isSubmitting,
}: {
  plan: ManualStepRunPlan;
  hostName: string;
  /** `## 前提条件`の「実行するデバイス」。代行できない理由の説明に使う */
  device: string | null;
  consent: boolean;
  onConsentChange: (consent: boolean) => void;
  onApprove: () => void;
  isSubmitting: boolean;
}) {
  const pending = plan.entries.filter((entry) => !entry.checked);
  if (pending.length === 0) return null;

  // 1件も代行できない場合は、承認ではなく**理由**を出す（押せないボタンを出さない）
  if (plan.runnable === 0) {
    const rejection = pending[0].rejection;
    return (
      <p className="flex items-start gap-2 rounded-md border bg-muted/50 p-2.5 text-xs text-muted-foreground">
        <Terminal className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          {rejection === null
            ? "この手作業は画面からは代行できません。手順どおり実行してください。"
            : describeManualStepExecutionRejection(rejection, { hostName, device })}
        </span>
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-2 rounded-md border border-violet-500/40 bg-violet-500/5 p-2.5">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
        <Zap className="size-3.5 shrink-0" aria-hidden />
        {describeManualStepRunPlan(plan)}を続けて実行できます
        <span className="ml-auto font-normal text-muted-foreground">{hostName}</span>
      </h4>

      <ol className="flex flex-col gap-2">
        {plan.entries.map((entry) => (
          <li
            key={entry.line}
            className={cn(
              "flex flex-col gap-1.5 rounded-md border bg-background p-2",
              (entry.checked || entry.rejection !== null) && "opacity-70",
            )}
          >
            <div className="flex items-center gap-2 text-xs">
              <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                {entry.kind === "step" ? entry.order : "確認"}
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold">{entry.text}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {entry.checked ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                    <Check className="size-3" aria-hidden />
                    実行済み
                  </span>
                ) : entry.rejection === null ? (
                  "代行できる"
                ) : (
                  "あなたが実行"
                )}
              </span>
            </div>
            {entry.command !== null && !entry.checked && (
              <pre className="overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                {entry.command}
              </pre>
            )}
            {entry.rejection !== null && !entry.checked && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {describeManualStepExecutionRejection(entry.rejection, { hostName, device })}
              </p>
            )}
          </li>
        ))}
      </ol>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        上から順に1件ずつ実行し、終了コード0のときだけ手順にチェックを付けて次へ進みます。
        失敗した時点で止まり、あなたが実行する手順に来たときも止まります。
        完了の確認は実行して結果を出すだけで、チェックもクローズもしません。
        出力はこの画面にだけ表示し、GitHubのIssueには残しません。
        <strong className="font-semibold">出力にシークレットが混ざることがあります。</strong>
        1件あたり{MANUAL_STEP_TIMEOUT_SECONDS / 60}分で打ち切ります。
      </p>

      <label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
        <Checkbox
          checked={consent}
          onCheckedChange={(checked) => onConsentChange(checked === true)}
          className="mt-0.5 shrink-0"
        />
        <span>失敗したら、コマンドと出力をClaudeへ送って原因と修正案を出す</span>
      </label>

      <div className="flex justify-end">
        <Button size="sm" disabled={isSubmitting} onClick={onApprove}>
          {isSubmitting ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          承認して{plan.runnable}件を自動実行
        </Button>
      </div>
    </section>
  );
}
