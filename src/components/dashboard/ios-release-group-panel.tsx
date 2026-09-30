"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Smartphone } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { RunRow } from "@/components/dashboard/ios-testflight-status";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useIosTestflight } from "@/hooks/use-ios-testflight";
import { judgeIosReleasePanel, type IosDispatchBlock } from "@/lib/ios-testflight-status";

const DISPATCH_ERROR: Record<IosDispatchBlock | string, string> = {
  not_merged: "このリリースはまだmainへマージされていません。",
  not_main_tip: "このリリースはmainの先端ではないため、ここからは配布できません。",
  deploy_not_succeeded: "Webの本番デプロイが成功していないため、配布できません。",
  already_delivered: "この版はすでにTestFlightへ配布済みです。",
  run_in_progress: "iOS配布がすでに実行中です。",
  ios_workflow_missing: "このリポジトリにはiOS配布のワークフローがありません。",
};

/** 起動直後にrunが一覧へ現れるまで待つ上限（ミリ秒）。この間はボタンを押せなくする */
const LAUNCH_WAIT_MS = 60_000;

/**
 * ブランチ画面のリリース束に置くiOS配布欄（#3644）。Webの本番デプロイとは別の行にし、
 * iOSの成否をWebの成否と混ぜない。対象は`webview-ios-repos.ts`のリポジトリの、mainへマージ済みの束。
 */
export function IosReleaseGroupPanel({
  owner,
  repo,
  prNumber,
  version,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  version: string | null;
}) {
  const { data, error, isLoading, refresh } = useIosTestflight(owner, repo, true, prNumber);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [launchedAt, setLaunchedAt] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const release = data?.available ? data.release : undefined;
  const hasRun = data?.available === true && data.runs.some((run) => run.status !== "completed");

  // 起動直後はrunが一覧に出るまで数秒かかる。出るか上限に達するまで取り直し、その間は再起動できない
  useEffect(() => {
    if (launchedAt === null) return;
    if (hasRun || Date.now() - launchedAt > LAUNCH_WAIT_MS) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLaunchedAt(null);
      return;
    }
    const timer = window.setInterval(refresh, 8_000);
    const stop = window.setTimeout(() => setLaunchedAt(null), LAUNCH_WAIT_MS);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [launchedAt, hasRun, refresh]);

  if (!data || !data.available || !release || !release.merged || release.sha === null) return null;

  const sha = release.sha;
  const state = judgeIosReleasePanel({
    webDeploy: release.webDeploy,
    isMainTip: release.isMainTip,
    deliveredBuild: release.deliveredBuild,
    runs: data.runs,
    sha,
  });
  const latestRun = data.runs[0];
  const launching = launchedAt !== null;
  const canDispatch = (state.kind === "ready" || state.kind === "failed") && !launching;

  async function dispatch() {
    setSubmitting(true);
    setActionError(null);
    try {
      const res = await fetch("/api/repositories/ios-testflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, prNumber }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new Error(DISPATCH_ERROR[body?.error ?? ""] ?? body?.message ?? `起動に失敗しました (${res.status})`);
      }
      setOpen(false);
      setLaunchedAt(Date.now());
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  let label: React.ReactNode;
  switch (state.kind) {
    case "awaiting-web":
      label = (
        <span className="text-muted-foreground">
          {state.failed ? "Webの本番デプロイが失敗しているため、iOSは操作できません" : "Webの本番反映後に操作できます"}
        </span>
      );
      break;
    case "not-needed":
      label = <span className="text-muted-foreground">iOS更新不要</span>;
      break;
    case "delivered":
      label = (
        <span className="text-green-700 dark:text-green-400">
          TestFlightへ配布済み{state.buildNumber !== null ? ` #${state.buildNumber}` : ""}
        </span>
      );
      break;
    case "running":
      label = <span className="text-blue-700 dark:text-blue-400">TestFlightへ配布中</span>;
      break;
    case "failed":
      label = (
        <span className="text-destructive font-semibold">
          {state.failedStage ? `iOS配布に失敗（${state.failedStage}）` : "iOS配布に失敗"}
        </span>
      );
      break;
    case "stale":
      label = <span className="text-muted-foreground">最新のmainではないため、ここからは配布できません</span>;
      break;
    default:
      label = <span>iOS未配布（更新の要否は起動後に判定されます）</span>;
  }

  // 段階の内訳は、実行中と失敗のときだけ出す（更新不要・配布済みには不要）
  const detailRun =
    state.kind === "running"
      ? data.runs.find((run) => run.status !== "completed")
      : state.kind === "failed"
        ? data.runs.find((run) => run.headSha === sha)
        : undefined;

  return (
    <div className="mt-1 flex max-w-2xl flex-col gap-1 rounded border border-dashed px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Smartphone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">iOS配布</span>
        {label}
        {launching && <span className="text-muted-foreground">起動しています…</span>}
        {canDispatch && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setOpen(true)}>
            {state.kind === "failed" ? "再実行" : "iOSへ配布"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-1.5 text-xs"
          onClick={refresh}
          disabled={isLoading}
          aria-label="iOS配布の状態を更新"
        >
          <RefreshCw className={isLoading ? "size-3 animate-spin" : "size-3"} aria-hidden="true" />
        </Button>
      </div>
      {(error || actionError) && <p className="text-destructive">{error ?? actionError}</p>}
      {detailRun && <RunRow run={detailRun} />}
      {state.kind === "not-needed" && latestRun && (
        <GithubReferenceLink href={latestRun.htmlUrl} className="self-start underline underline-offset-2">
          判定の詳細を開く
        </GithubReferenceLink>
      )}

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{version ? `v${version} をiOSへ配布しますか？` : "iOSへ配布しますか？"}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-1">
                <span>対象のmainコミット：{sha.slice(0, 7)}</span>
                <span>
                  iOS変更の判定：
                  {state.kind === "failed"
                    ? "前回の実行で判定済み。失敗した段階から通しでやり直します"
                    : "起動後に判定されます（更新が不要なら、ビルドせず終わります）"}
                </span>
                <span>iOS更新が必要な場合、署名・ビルド・アップロードの後、TestFlightの内部グループへ配布されます。</span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {actionError && <p className="text-destructive text-sm">{actionError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(event) => {
                event.preventDefault();
                void dispatch();
              }}
            >
              {submitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              配布する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
