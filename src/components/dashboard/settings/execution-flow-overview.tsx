"use client";

import { Fragment } from "react";

import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/dashboard/settings/info-hint";
import { providerName, ScopeChip, scrollToSetting } from "@/components/dashboard/settings/ai-model-layout";
import { cn } from "@/lib/utils";
import type { AiExecutionProvider } from "@/lib/app-settings";
import {
  resolveProviderFlowRows,
  type AiProviderOverrides,
  type ProviderFlowBinding,
  type ProviderFlowSettings,
} from "@/lib/execution-flow-settings";

type ExecutionFlowOverviewProps = ProviderFlowSettings & {
  aiExecutionProvider: AiExecutionProvider;
  overrides: AiProviderOverrides;
  /** この画面に置かれている設定欄のid。無い欄へは「設定へ」を出さない */
  linkableSourceIds: readonly string[];
};

const BINDING_LABELS: Record<ProviderFlowBinding, { label: string; className: string; description: string }> = {
  provider: {
    label: "追従",
    className: "bg-primary/10 text-primary",
    description: "プロバイダーの切替で変わります",
  },
  override: {
    label: "個別設定",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    description: "個別に固定しているため、プロバイダーを切り替えても変わりません",
  },
  implementation: {
    label: "実装に追従",
    className: "border bg-muted text-muted-foreground",
    description: "その前に実装したエージェントの側で動きます",
  },
  opposite: {
    label: "開始元と別",
    className: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    description: "計画を出したエージェントとは別のエージェントで動きます（全体プロバイダーには追従しません）",
  },
  independent: {
    label: "固定",
    className: "border bg-muted text-muted-foreground",
    description: "プロバイダーと関係しない設定です",
  },
};

function BindingBadge({ binding }: { binding: ProviderFlowBinding }) {
  const { label, className, description } = BINDING_LABELS[binding];
  return (
    <span title={description} className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold", className)}>
      {label}
    </span>
  );
}

/**
 * 実行場所の表示名。ローカルの実行先はDeskMini・Mac miniのどちらでも同じ設定値で動くため、
 * 画面では特定の機体名ではなく「ローカル」と出す（#5643）
 */
function locationLabel(label: string) {
  return label.replaceAll("DeskMini", "ローカル");
}

/**
 * 「いまの実行内容」（#4108・#5643）。工程ごとに、どこで何が動くかを確認するための表。
 *
 * 設定欄とは分けて区分の最後に置き、入力と確認を混ぜない。プロバイダーの切替や各欄の変更は、
 * 保存前でもその場で反映する。行の「設定へ」で、その値を決めている欄へ移る。
 */
export function ExecutionFlowOverview({
  aiExecutionProvider,
  overrides,
  linkableSourceIds,
  ...settings
}: ExecutionFlowOverviewProps) {
  const rows = resolveProviderFlowRows(settings, aiExecutionProvider, overrides);

  return (
    <section id="execution-flow-summary" tabIndex={-1} aria-labelledby="execution-flow-summary-title" className="scroll-mt-2 rounded-lg border bg-card p-4 outline-none">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="execution-flow-summary-title" className="font-medium">いまの実行内容</h3>
        <ScopeChip tone="muted">確認用・保存前の選択も反映</ScopeChip>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">工程ごとに、どこで何が動くか。「設定へ」で、その値を決めている欄へ移動します。</p>

      <ol className="mt-3 flex flex-col border-t" aria-label={`${providerName(aiExecutionProvider)}を選んだときの各工程`}>
        {rows.map((row) => (
          <Fragment key={row.step}>
            <li className="grid grid-cols-1 gap-1.5 border-b py-2.5 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto] sm:gap-3">
              <span className="text-sm font-semibold sm:pt-0.5">{row.step}</span>
              <div className="flex min-w-0 flex-col gap-1.5">
                {row.entries.map((entry) => (
                  <div key={entry.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-0.5 text-sm sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
                    <span className="col-span-2 text-[11px] text-muted-foreground sm:col-span-1">{locationLabel(entry.label)}</span>
                    <span className="min-w-0 break-words">
                      <span className="text-muted-foreground">{entry.agent} / </span>
                      <span className="font-semibold">{entry.model}</span>
                      {entry.reasoningEffort && <span className="ml-1 text-[11px] text-muted-foreground">推論強度 {entry.reasoningEffort}</span>}
                      {entry.note && <span className="ml-1 inline-flex align-middle"><InfoHint label={`${row.step}（${locationLabel(entry.label)}）`}>{entry.note}</InfoHint></span>}
                    </span>
                    <BindingBadge binding={entry.binding} />
                  </div>
                ))}
              </div>
              <div className="sm:pt-0.5">
                {linkableSourceIds.includes(row.sourceId) ? (
                  <Button type="button" variant="link" className="h-auto px-0 text-xs" onClick={() => scrollToSetting(row.sourceId)}>
                    設定へ
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">「自動化」で変更</span>
                )}
              </div>
            </li>
          </Fragment>
        ))}
      </ol>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="表示の見方">
        {(["provider", "override", "implementation", "independent"] as const).map((binding) => (
          <li key={binding} className="flex items-center gap-1.5"><BindingBadge binding={binding} />{BINDING_LABELS[binding].description}</li>
        ))}
      </ul>
    </section>
  );
}
