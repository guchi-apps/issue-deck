"use client";

import { AlertTriangle, Check, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useWorkflowTags } from "@/hooks/use-workflow-tags";
import type { WorkflowTagStatus as Status } from "@/lib/workflow-tags";

/**
 * 各リポジトリが参照している共有ワークフローのタグを一覧する（#985）。
 *
 * **なぜ画面に出すか。** 共有ワークフローは`uses:`のタグ固定で配っており、issue-deck側を
 * 直しても各リポジトリのcallerを上げるまで反映されない。**上げ忘れても何も起きないため
 * 気づけない。** 実際`workflows/v10`はcar-careだけに配られ、他9リポジトリは`v9`のまま
 * だった（#1147の修正が届いていない状態）。
 */
function statusLabel(status: Status, latest: string | null): { text: string; tone: string } {
  if (status.mismatched) {
    // 古いかどうかとは別種の異常。新しいワークフローで古いプロンプトが動く
    return { text: "uses と prompts-ref が不一致", tone: "text-destructive" };
  }
  if (status.outdated) {
    return { text: `${latest ?? "最新"} へ未更新`, tone: "text-amber-500" };
  }
  return { text: "最新", tone: "text-muted-foreground" };
}

/** 同じタグに揃っていれば1つ、混在していれば全部を出す */
function summarizeTags(status: Status): string {
  const tags = [...new Set(status.refs.map((ref) => ref.uses))];
  return tags.join(" / ");
}

export function WorkflowTagStatusSection({ open }: { open: boolean }) {
  const { overview, isLoading, error, reload } = useWorkflowTags(open);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">共有ワークフローのバージョン</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={reload}
          disabled={isLoading}
          aria-label="再取得"
        >
          <RefreshCw className={isLoading ? "animate-spin" : undefined} />
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!error && isLoading && !overview && (
        <p className="text-xs text-muted-foreground">読み込み中...</p>
      )}

      {overview && (
        <>
          <p className="text-xs text-muted-foreground">
            issue-deck側の最新: {overview.latest ?? "（取得できませんでした）"}
          </p>

          {overview.repositories.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              共有ワークフローを参照しているリポジトリはありません。
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {overview.repositories.map((status) => {
                const label = statusLabel(status, overview.latest);
                const ok = !status.outdated && !status.mismatched;
                return (
                  <li key={status.fullName} className="flex items-center gap-2 text-xs">
                    {ok ? (
                      <Check className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <AlertTriangle className={`size-3.5 shrink-0 ${label.tone}`} />
                    )}
                    <span className="truncate">{status.fullName}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                      {summarizeTags(status)}
                    </span>
                    {!ok && <span className={`shrink-0 ${label.tone}`}>{label.text}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <p className="text-xs text-muted-foreground">
        各リポジトリの<code>.github/workflows/</code>が参照しているタグです。issue-deck側の改善は、
        参照タグを上げるまで反映されません。<strong>uses と prompts-ref が食い違うと、新しい
        ワークフローで古いプロンプトが使われます。</strong>
      </p>
    </div>
  );
}
