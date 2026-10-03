import { ChevronRight } from "lucide-react";

import {
  resolveExecutionFlows,
  type ExecutionFlowSettings,
} from "@/lib/execution-flow-settings";

type ExecutionFlowOverviewProps = ExecutionFlowSettings;

const GROUPS = ["計画", "実装", "レビュー", "修復", "アプリ内AI", "判定"] as const;

/**
 * 「設定キー」ではなく、今起動したときの処理単位で実行環境を読むための一覧。
 * 横幅を必要とする表を避け、同じ情報をモバイルでも読めるカードにする。
 */
export function ExecutionFlowOverview(props: ExecutionFlowOverviewProps) {
  const flows = resolveExecutionFlows(props);

  return (
    <section aria-labelledby="execution-flows-heading" className="flex flex-col gap-4">
      <div>
        <h3 id="execution-flows-heading" className="text-sm font-semibold">実行フロー</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          現在の保存前の設定から、処理ごとの実行場所・エージェント・実効モデルを表示します。設定を変えた場合も、保存前にここで結果を確認できます。
        </p>
      </div>
      {GROUPS.map((group) => {
        const groupFlows = flows.filter((flow) => flow.group === group);
        if (groupFlows.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-2">
            <h4 className="border-b pb-1 text-xs font-semibold tracking-wide text-muted-foreground">{group}</h4>
            {groupFlows.map((flow) => (
              <article key={`${flow.name}-${flow.agent}`} className="rounded-lg border bg-card p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <h5 className="font-medium">{flow.name}</h5>
                  {flow.sourceId && (
                    <a href={`#${flow.sourceId}`} className="flex shrink-0 items-center text-xs text-primary underline-offset-2 hover:underline">
                      設定を変更 <ChevronRight className="size-3" />
                    </a>
                  )}
                </div>
                <dl className="mt-2 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">実行場所</dt><dd>{flow.location}</dd>
                  <dt className="text-muted-foreground">エージェント</dt><dd>{flow.agent}</dd>
                  <dt className="text-muted-foreground">実効モデル</dt><dd className="font-medium">{flow.model}</dd>
                  <dt className="text-muted-foreground">設定元</dt><dd>{flow.source}</dd>
                </dl>
                {flow.note && <p className="mt-2 border-t pt-2 text-xs leading-relaxed text-muted-foreground">{flow.note}</p>}
              </article>
            ))}
          </div>
        );
      })}
    </section>
  );
}
