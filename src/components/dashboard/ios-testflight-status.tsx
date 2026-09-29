"use client";

import { RefreshCw } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { Button } from "@/components/ui/button";
import { useIosTestflight, type IosTestflightRun } from "@/hooks/use-ios-testflight";
import { formatDateTime } from "@/lib/format-date-time";
import type { IosRunVerdict, IosStageState } from "@/lib/ios-testflight-status";

const STATE_LABEL: Record<IosStageState, string> = {
  success: "成功",
  failure: "失敗",
  running: "実行中",
  pending: "待機中",
  skipped: "スキップ",
  unknown: "—",
};

const STATE_CLASS: Record<IosStageState, string> = {
  success: "text-green-700 dark:text-green-400",
  failure: "text-destructive font-semibold",
  running: "text-blue-700 dark:text-blue-400",
  pending: "text-muted-foreground",
  skipped: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

function verdictText(verdict: IosRunVerdict): { text: string; className: string } {
  switch (verdict.kind) {
    case "delivered":
      return { text: "TestFlightへ配布済み", className: "text-green-700 dark:text-green-400" };
    case "skipped":
      return { text: "iOS更新は不要と判定（ビルドなし）", className: "text-muted-foreground" };
    case "failed":
      return {
        text: verdict.failedStage ? `iOS配布に失敗（${verdict.failedStage}）` : "iOS配布に失敗",
        className: "text-destructive font-semibold",
      };
    case "running":
      return { text: "iOS配布を実行中", className: "text-blue-700 dark:text-blue-400" };
    default:
      return { text: "結果を判定できません（実行を開くと確認できます）", className: "text-muted-foreground" };
  }
}

function RunRow({ run }: { run: IosTestflightRun }) {
  const verdict = verdictText(run.verdict);
  return (
    <div className="flex flex-col gap-1 rounded border bg-background/60 px-2 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className={verdict.className}>{verdict.text}</span>
        <span className="text-muted-foreground">
          {formatDateTime(run.createdAt)} ・ {run.headSha.slice(0, 7)}
        </span>
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-3">
        {run.stages.map((stage) => (
          <li key={stage.key} className="flex justify-between gap-2">
            <span>{stage.label}</span>
            <span className={STATE_CLASS[stage.state]}>{STATE_LABEL[stage.state]}</span>
          </li>
        ))}
      </ul>
      {run.notes.length > 0 && (
        <ul className="list-disc pl-4 text-muted-foreground">
          {run.notes.map((note) => (
            <li key={note} className="break-words">
              {note}
            </li>
          ))}
        </ul>
      )}
      <GithubReferenceLink href={run.htmlUrl} className="self-start underline underline-offset-2 hover:text-foreground">
        実行の詳細・ステップサマリーを開く
      </GithubReferenceLink>
    </div>
  );
}

/**
 * リリース画面のiOS（TestFlight）配布結果（#3626）。Webのデプロイとは別の欄にし、iOSの失敗を
 * Webの成功として隠さない。ワークフロー（kurashio#591）が無いリポジトリでは何も出さない。
 */
export function IosTestflightStatus({ owner, repo }: { owner: string; repo: string }) {
  const { data, error, isLoading, refresh } = useIosTestflight(owner, repo, true);

  if (data && !data.available) return null;

  return (
    <div className="flex max-w-2xl flex-col gap-2 rounded-md border px-3 py-3 text-xs">
      <div className="flex items-center justify-between">
        <p className="font-semibold">iOS配布（TestFlight）の結果</p>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={refresh} disabled={isLoading}>
          <RefreshCw className={isLoading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
          更新
        </Button>
      </div>
      <p className="text-muted-foreground">Webの本番デプロイとは別に、iOS側の判定と配布の成否を表示します。</p>
      {error && <p className="text-destructive">{error}</p>}
      {!data && !error && <p className="text-muted-foreground">読み込み中...</p>}
      {data?.available && (
        <>
          <p>
            最後にTestFlightへ配布したビルド：
            <span className="font-medium">
              {data.latestDeliveredBuild ? `#${data.latestDeliveredBuild.buildNumber}` : "記録なし"}
            </span>
          </p>
          {data.runs.length === 0 ? (
            <p className="text-muted-foreground">まだ実行がありません。</p>
          ) : (
            data.runs.map((run) => <RunRow key={run.id} run={run} />)
          )}
        </>
      )}
    </div>
  );
}
