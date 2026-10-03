"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Plus, RefreshCw, Smartphone } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { IosRunProgressPanel } from "@/components/dashboard/ios-run-progress-panel";
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
import { buildIosDistributionFixIssueDraft, type IosDistributionFixIssueDraft } from "@/lib/ios-distribution-failure";
import { judgeIosReleasePanel, type IosDispatchBlock } from "@/lib/ios-testflight-status";

const DISPATCH_ERROR: Record<IosDispatchBlock | string, string> = {
  not_merged: "このリリースはまだmainへマージされていません。",
  not_main_tip: "このリリースはmainの先端ではないため、ここからは配布できません。",
  deploy_not_succeeded: "Webの本番デプロイが成功していないため、配布できません。",
  already_delivered: "この版はすでにTestFlightへ配布済みです。",
  run_in_progress: "iOS配布がすでに実行中です。",
  ios_workflow_missing: "このリポジトリにはiOS配布のワークフローがありません。",
};

/** 内訳の自動更新の間隔（#3665） */
const AUTO_REFRESH_MS = 10_000;

/** 起動直後にrunが一覧へ現れるまで待つ上限（ミリ秒）。この間はボタンを押せなくする */
const LAUNCH_WAIT_MS = 60_000;

/**
 * 「修正Issueを起案」で下書きを開くときに渡す、起案元の失敗した実行（#3784）。
 * 起票されたIssueを追跡Issueとして登録するときに使う。
 */
export type IosFixIssueOrigin = {
  repositoryFullName: string;
  runId: number;
  runUrl: string;
  failedStage: string | null;
};

/**
 * 失敗時の「修正Issueを起案」の送り先（#3784）。**ここでは起票せず**、下書き入りの新規作成ダイアログを
 * 開くのは親（`BranchFlowView`の呼び出し元）の仕事。束の描画の途中に何段もあるため、propsの中継ではなく
 * contextで渡す。提供されなければボタンを出さない。
 */
export const IosFixIssueDraftContext = createContext<
  ((draft: IosDistributionFixIssueDraft, origin: IosFixIssueOrigin) => void) | undefined
>(undefined);

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
  const onDraftFixIssue = useContext(IosFixIssueDraftContext);
  // null=自動（実行中・失敗のときだけ開く）。人が開閉したらその値を優先する
  const [detailToggle, setDetailToggle] = useState<boolean | null>(null);
  const [tipKnown, setTipKnown] = useState<boolean | null>(null);
  const { data, error, isLoading, refresh, lastFetchedAt } = useIosTestflight(owner, repo, true, prNumber, {
    pollIntervalMs: AUTO_REFRESH_MS,
    pollWhileActive: detailToggle === true,
    // 過去の版（mainの先端でない束）は追わない
    pollPaused: tipKnown === false,
  });
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [launchedAt, setLaunchedAt] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const release = data?.available ? data.release : undefined;
  const isMainTip = release?.isMainTip ?? null;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTipKnown(isMainTip);
  }, [isMainTip]);
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

  // 内訳に出す実行。実行中があればそれ、失敗ならその版の失敗した実行、それ以外は直近の実行
  const detailRun =
    (state.kind === "running"
      ? data.runs.find((run) => run.status !== "completed")
      : state.kind === "failed"
        ? data.runs.find((run) => run.headSha === sha)
        : undefined) ?? latestRun;
  const trackedIssue = data.trackedIssue ?? null;
  const failedRun = state.kind === "failed" ? data.runs.find((run) => run.headSha === sha) : undefined;
  function draftFixIssue() {
    if (!onDraftFixIssue || !failedRun) return;
    const failedStage = failedRun.stages.find((stage) => stage.state === "failure")?.label ?? null;
    onDraftFixIssue(
      buildIosDistributionFixIssueDraft({
        repositoryFullName: `${owner}/${repo}`,
        version,
        sha,
        runUrl: failedRun.htmlUrl,
        failedStage,
        notes: failedRun.notes,
      }),
      { repositoryFullName: `${owner}/${repo}`, runId: failedRun.id, runUrl: failedRun.htmlUrl, failedStage },
    );
  }
  const autoOpen = state.kind === "running" || state.kind === "failed";
  const detailOpen = detailToggle ?? autoOpen;
  // 内訳を開いている、または実行中のrunがあるあいだだけ自動更新する（フック側の条件と同じ）
  const autoRefreshing = tipKnown !== false && (detailOpen || data.runs.some((run) => run.status !== "completed"));

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
        {state.kind === "failed" && trackedIssue && (
          <Button asChild size="sm" variant="outline" className="h-6 px-2 text-xs">
            <GithubReferenceLink
              href={trackedIssue.htmlUrl}
              reference={{ repositoryFullName: `${owner}/${repo}`, number: trackedIssue.number, kind: "issue" }}
            >
              <ExternalLink aria-hidden="true" />
              起票済み（#{trackedIssue.number}）
            </GithubReferenceLink>
          </Button>
        )}
        {state.kind === "failed" && !trackedIssue && failedRun && onDraftFixIssue && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={draftFixIssue}>
            <Plus aria-hidden="true" />
            修正Issueを起案
          </Button>
        )}
        {detailRun && (
          <button
            type="button"
            onClick={() => setDetailToggle(!detailOpen)}
            aria-expanded={detailOpen}
            className="inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground hover:text-foreground"
            title={detailOpen ? "実行の内訳を閉じる" : "実行の内訳を開く"}
            aria-label={detailOpen ? "実行の内訳を閉じる" : "実行の内訳を開く"}
          >
            {detailOpen ? (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden="true" />
            )}
          </button>
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
      {detailRun && detailOpen && (
        <IosRunProgressPanel
          run={detailRun}
          lastFetchedAt={lastFetchedAt}
          autoRefreshLabel={autoRefreshing ? `自動更新中（${AUTO_REFRESH_MS / 1000}秒）` : undefined}
        />
      )}
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
