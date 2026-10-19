"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Rocket, Square } from "lucide-react";

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
import {
  RELEASE_COMPLETION_COST_LIMIT_USD,
  RELEASE_COMPLETION_SCOPE_PRODUCTION,
  RELEASE_COMPLETION_SCOPE_READY,
  RELEASE_COMPLETION_STAGES,
  type ReleaseCompletionScope,
} from "@/lib/release-completion";
import type { ReleaseCompletionRunView } from "@/lib/release-completion-run";
import { formatMonthDayTime } from "@/lib/format-date-time";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 15_000;

/**
 * 完了系列の取得とポーリング（#4498）。要約帯とこのパネルが別々に取ると更新がずれて見出しが食い違うため、
 * 親が1回だけ呼んで結果を渡す。`run`は取得前がundefined、系列が無ければnull。別PRの結果は使わない
 */
export function useReleaseCompletionRun(repositoryFullName: string, pullRequestNumber: number, enabled = true) {
  const [owner, repo] = repositoryFullName.split("/");
  const [stored, setStored] = useState<{ key: string; value: ReleaseCompletionRunView | null } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const key = `${repositoryFullName}#${pullRequestNumber}`;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchRun(owner, repo, pullRequestNumber).then((value) => {
      if (!cancelled && value !== undefined) setStored({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [owner, repo, pullRequestNumber, key, reloadKey, enabled]);

  const run = stored && stored.key === key ? stored.value : undefined;
  const active = run?.active ?? false;
  useEffect(() => {
    if (!enabled || !active) return;
    const timer = setInterval(() => setReloadKey((n) => n + 1), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, enabled]);

  return { run, setRun: (value: ReleaseCompletionRunView | null) => setStored({ key, value }) };
}

type Props = {
  /** 親が取得した結果を使う。省略時はこのパネルが自分で取得する */
  runState?: { run: ReleaseCompletionRunView | null | undefined; setRun: (run: ReleaseCompletionRunView | null) => void };
  repositoryFullName: string;
  pullRequestNumber: number;
  /** 画面で見ている検証の対象。開始時にサーバーが今の候補と照合する */
  target: { baseSha: string; headSha: string } | null;
  /** 候補に問題がある、または修正の記録があるときだけ開始できる（問題の無い候補は通常のリリース） */
  canStart: boolean;
};

/**
 * リリース候補の「リリース完了まで進める」（#4480）と、その系列の現在状態。PC・スマホで同じ部品を使う。
 *
 * 開始は1回だけで、以後の工程（修正Issueの起動・修正のレビュー・候補の作り直し・再チェック・許可した範囲の
 * 本番マージ・デプロイ・稼働確認）ごとの再操作は求めない。押す前に**どこまで自動で進めるか**を選ばせ、
 * 本番へのマージは開始者が選んだ系列だけにする。
 */
export function ReleaseCompletionPanel({ runState, repositoryFullName, pullRequestNumber, target, canStart }: Props) {
  const [owner, repo] = repositoryFullName.split("/");
  const own = useReleaseCompletionRun(repositoryFullName, pullRequestNumber, !runState);
  const { run: shownRun, setRun: setShownRun } = runState ?? own;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scope, setScope] = useState<ReleaseCompletionScope | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (scope === null) return;
    setBusy("start");
    setError(null);
    try {
      const res = await fetch("/api/repositories/release/completion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, pullRequestNumber, scope, baseSha: target?.baseSha, headSha: target?.headSha }),
      });
      const data = (await res.json().catch(() => null)) as { run?: ReleaseCompletionRunView; error?: string } | null;
      if (data?.run) setShownRun(data.run);
      if (!res.ok) setError(startErrorMessage(data?.error));
    } catch {
      setError("通信に失敗しました。押し直してください。");
    } finally {
      setBusy(null);
      setConfirmOpen(false);
    }
  }

  async function stop() {
    if (!shown) return;
    setBusy("stop");
    setError(null);
    try {
      const res = await fetch("/api/repositories/release/completion", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, runId: shown.id }),
      });
      const data = (await res.json().catch(() => null)) as { run?: ReleaseCompletionRunView } | null;
      if (data?.run) setShownRun(data.run);
      if (!res.ok) setError("停止できませんでした。押し直してください。");
    } catch {
      setError("通信に失敗しました。押し直してください。");
    } finally {
      setBusy(null);
    }
  }

  const shown = shownRun ?? null;
  const loaded = shownRun !== undefined;
  const showStart = loaded && canStart && !shown?.active;
  if (!shown && !showStart && !error) return null;

  return (
    <div className="flex flex-col gap-1.5" data-testid="release-completion">
      {shown && <RunCard run={shown} busy={busy} onStop={() => void stop()} />}
      {showStart && (
        <Button size="sm" className="h-7 w-fit gap-1 px-3 text-xs" onClick={() => { setScope(null); setConfirmOpen(true); }} disabled={busy !== null}>
          {busy === "start" ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Rocket className="size-3" aria-hidden="true" />}
          リリース完了まで進める
        </Button>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>リリース完了まで進めますか</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm" data-testid="release-completion-dialog">
                <p>このリリース候補（#{pullRequestNumber}）に限って、次の工程を確認なしで進めます。</p>
                <ol className="list-decimal pl-5">
                  <li>失敗の原因を区分する（実行障害の疑いなら修正Issueは作らず止めて知らせる）</li>
                  <li>修正Issueを作り、修正を自動で開始する（内部のレビュー往復は修正セッションの中で行う）</li>
                  <li>修正PRがdevelopへ入ったら、その修正だけを候補へ足して作り直す（履歴だけの差もこの経路で反映する）</li>
                  <li>
                    作り直した候補で全体レビュー・統合検証・iOS検証をやり直す。指摘が残れば同じ修正Issueで続ける（世代の回数では止めず、停滞・予算到達・本人判断のときだけ理由つきで一時停止）
                  </li>
                </ol>
                <ScopeOption
                  id="release-completion-scope-ready"
                  checked={scope === RELEASE_COMPLETION_SCOPE_READY}
                  onSelect={() => setScope(RELEASE_COMPLETION_SCOPE_READY)}
                  title="チェック通過まで"
                  body="本番へのマージは人が行います。マージ後は稼働確認まで追跡します。"
                />
                <ScopeOption
                  id="release-completion-scope-production"
                  checked={scope === RELEASE_COMPLETION_SCOPE_PRODUCTION}
                  onSelect={() => setScope(RELEASE_COMPLETION_SCOPE_PRODUCTION)}
                  title="本番反映・稼働確認まで"
                  body="現在のmainと候補の先端に対する検証・CIがすべて合格し、作り直した候補が記録と一致するときだけ自動で本番へマージし、デプロイ成功と稼働中の版の一致を確かめて完了にします。デプロイが失敗したら同じ系列で調べ直します。"
                />
                <p className="text-xs text-muted-foreground">
                  許可はこの候補の系列だけに有効で、通常のリリースには及びません。mainが進んだ・候補が系列の外で作り直された・費用の上限（$
                  {RELEASE_COMPLETION_COST_LIMIT_USD}）・24時間の期限に達したときは止めて知らせます。途中でいつでも停止できます。
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void start();
              }}
              disabled={busy !== null || scope === null}
            >
              {busy === "start" && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              開始する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ScopeOption({ id, checked, onSelect, title, body }: { id: string; checked: boolean; onSelect: () => void; title: string; body: string }) {
  return (
    <label
      htmlFor={id}
      className={cn("flex items-start gap-2 rounded-md border p-2", checked && "border-primary bg-primary/10")}
    >
      <input id={id} type="radio" name="release-completion-scope" className="mt-1" checked={checked} onChange={onSelect} />
      <span>
        <span className="font-semibold text-foreground">{title}</span>
        <br />
        <span className="text-muted-foreground">{body}</span>
      </span>
    </label>
  );
}

function RunCard({ run, busy, onStop }: { run: ReleaseCompletionRunView; busy: "start" | "stop" | null; onStop: () => void }) {
  const github = `https://github.com/${run.repositoryFullName}`;
  const stopped = run.stageIndex < 0;
  const generation = run.fixes.length > 0 ? Math.max(...run.fixes.map((f) => f.generation)) : 0;
  const issues = [...new Set(run.fixes.map((f) => f.issueNumber))];
  const fixPrs = run.fixes.map((f) => f.fixPrNumber).filter((n): n is number => n !== null);
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-background/70 p-2" data-testid="release-completion-run">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">{run.fromPublishApproval ? "自動公開（公開承認済み）:" : "リリース完了まで進める:"}</span>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5",
            run.status === "completed"
              ? "border-emerald-600 text-emerald-700 dark:text-emerald-300"
              : stopped || run.needsAction
                ? "border-destructive text-destructive"
                : "text-foreground",
          )}
          data-testid="release-completion-status"
        >
          {run.needsAction && run.status !== "awaiting_approval" ? "操作が必要" : run.statusLabel}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {generation > 0 ? `世代 ${generation} ・ ` : ""}費用 ${run.costUsedUsd.toFixed(2)} / ${run.costLimitUsd} ・{" "}
          {run.fromPublishApproval ? "公開承認から本番反映・稼働確認まで" : run.scope === RELEASE_COMPLETION_SCOPE_PRODUCTION ? "本番反映・稼働確認まで許可" : "チェック通過まで許可"}
        </span>
        {run.active && (
          <button
            type="button"
            onClick={onStop}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 hover:bg-muted disabled:opacity-60"
          >
            {busy === "stop" ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Square className="size-3" aria-hidden="true" />}
            停止
          </button>
        )}
      </p>
      <ol className="grid grid-cols-3 gap-1 sm:grid-cols-6" aria-label="リリースの進行状況">
        {RELEASE_COMPLETION_STAGES.map((label, index) => (
          <li
            key={label}
            aria-current={index === run.stageIndex ? "step" : undefined}
            className={cn(
              "rounded-sm border-t-2 px-1.5 py-1 text-[11px] leading-tight",
              run.stageIndex > index || run.status === "completed"
                ? "border-emerald-600"
                : index === run.stageIndex
                  ? run.needsAction
                    ? "border-destructive bg-destructive/10 font-semibold"
                    : "border-primary bg-primary/10 font-semibold"
                  : "border-border text-muted-foreground",
            )}
          >
            {label}
          </li>
        ))}
      </ol>
      <p className="break-words leading-relaxed" data-testid="release-completion-note">
        {progressNote(run)}
      </p>
      {run.stopMessage && <p className="break-words leading-relaxed">{run.stopMessage}</p>}
      {run.note && <p className="break-words leading-relaxed text-muted-foreground">{run.note}</p>}
      {run.waitMessage && (
        <p
          className={cn("break-words leading-relaxed", run.waitStalled ? "font-medium text-amber-700 dark:text-amber-400" : "text-muted-foreground")}
          data-testid="release-completion-wait"
        >
          {run.waitStalled ? "長時間進んでいません: " : "いま待っているもの: "}
          {run.waitMessage}
        </p>
      )}
      {run.deployRecovery && (
        <p className="break-words leading-relaxed text-muted-foreground">
          デプロイ失敗からの復旧: {run.deployRecovery.statusLabel}
          {run.deployRecovery.stopMessage ? `（${run.deployRecovery.stopMessage}）` : ""}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-muted-foreground">詳細（Issue・PR・SHA・承認）</summary>
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5">
          {issues.length > 0 && (
            <>
              <dt className="text-muted-foreground">修正Issue</dt>
              <dd className="flex flex-wrap gap-x-2">
                {issues.map((n) => (
                  <Anchor key={n} href={`${github}/issues/${n}`}>#{n}</Anchor>
                ))}
              </dd>
            </>
          )}
          {fixPrs.length > 0 && (
            <>
              <dt className="text-muted-foreground">修正PR</dt>
              <dd className="flex flex-wrap gap-x-2">
                {fixPrs.map((n) => (
                  <Anchor key={n} href={`${github}/pull/${n}`}>#{n}</Anchor>
                ))}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">候補</dt>
          <dd className="flex flex-wrap items-center gap-x-1">
            {run.candidatePrNumbers.map((n, index) => (
              <span key={n} className="inline-flex items-center gap-1">
                {index > 0 && <span aria-hidden="true">→</span>}
                <Anchor href={`${github}/pull/${n}`}>#{n}</Anchor>
              </span>
            ))}
          </dd>
          <dt className="text-muted-foreground">対象SHA</dt>
          <dd className="font-mono text-[10.5px]">
            main {run.candidateBaseSha.slice(0, 7)} ← release {run.candidateHeadSha.slice(0, 7)}
            {run.mergeSha && ` ／ 本番 ${run.mergeSha.slice(0, 7)}`}
          </dd>
          <dt className="text-muted-foreground">承認</dt>
          <dd>
            {formatMonthDayTime(run.createdAt)} 開始（{run.scope === RELEASE_COMPLETION_SCOPE_PRODUCTION ? "本番反映・稼働確認まで" : "チェック通過まで"}／期限{" "}
            {formatMonthDayTime(run.expiresAt)}）
          </dd>
          {run.releaseRunUrl && (
            <>
              <dt className="text-muted-foreground">デプロイ</dt>
              <dd>
                <Anchor href={run.releaseRunUrl}>実行を開く</Anchor>
              </dd>
            </>
          )}
          {run.deployRecovery?.issueNumber != null && (
            <>
              <dt className="text-muted-foreground">本番復旧</dt>
              <dd>
                <Anchor href={`${github}/issues/${run.deployRecovery.issueNumber}`}>#{run.deployRecovery.issueNumber}</Anchor>
              </dd>
            </>
          )}
        </dl>
      </details>
    </div>
  );
}

/** 原因・残り・操作が要るかを1文で。経緯の詳細はIssue・PRで追える */
export function progressNote(run: Pick<ReleaseCompletionRunView, "status" | "scope" | "candidatePrNumber">): string {
  const rest = run.scope === RELEASE_COMPLETION_SCOPE_PRODUCTION ? "チェック通過 → 本番マージ → デプロイ → 稼働確認" : "チェック通過 → 本番承認";
  switch (run.status) {
    case "investigating":
      return `失敗の原因を調べています。操作は不要です。残り: 修正 → ${rest}。`;
    case "fixing":
      return `修正とレビューを進めています。操作は不要です。残り: ${rest}。`;
    case "checking":
      return `修正を反映した候補 #${run.candidatePrNumber} をチェックしています。操作は不要です。残り: ${rest}。`;
    case "awaiting_decision":
      return "修正の続行に判断が必要です。下の理由を確かめてください。";
    case "awaiting_approval":
      return `候補 #${run.candidatePrNumber} は全てのチェックを通過しました。操作が必要です: 本番へのマージは確認画面から人が行います。マージ後は、このまま稼働確認まで追跡します。`;
    case "merging":
      return `候補 #${run.candidatePrNumber} の本番マージの条件（CI・mainの位置）を確かめています。操作は不要です。`;
    case "releasing":
      return "本番へマージしました。デプロイを待っています。操作は不要です。";
    case "verifying":
      return "デプロイが成功しました。稼働中の版を確かめています。操作は不要です。";
    case "deploy_recovery":
      return "デプロイの失敗から、同じ系列のまま原因を調べ直しています。操作は不要です。";
    case "completed":
      return "完了しました。デプロイが成功し、稼働中の版が対象と一致しています。";
    case "stopped":
      return "停止しました。新しい操作は行いません。";
    default:
      return "操作が必要です。下の理由を確かめてください。";
  }
}

function startErrorMessage(error: string | undefined): string {
  switch (error) {
    case "run_active":
      return "このリポジトリでは別のリリース完了系列が進行中です。";
    case "release_pr_changed":
      return "リリース候補が更新されています。画面を更新してから押してください。";
    case "nothing_to_recover":
      return "この候補には直す失敗がありません。本番へのマージは通常のリリースとして行ってください。";
    case "not_release_pull_request":
      return "このPRはリリース候補ではありません。";
    default:
      return "開始できませんでした。時間をおいて押し直してください。";
  }
}

async function fetchRun(owner: string, repo: string, pullRequestNumber: number): Promise<ReleaseCompletionRunView | null | undefined> {
  try {
    const params = new URLSearchParams({ owner, repo, pullRequest: String(pullRequestNumber) });
    const res = await fetch(`/api/repositories/release/completion?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) return undefined;
    const data = (await res.json().catch(() => null)) as { run?: ReleaseCompletionRunView | null } | null;
    return data?.run ?? null;
  } catch {
    // 表示用の取得。失敗しても他の操作は使える
    return undefined;
  }
}

function Anchor({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
      <ExternalLink className="size-3" aria-hidden="true" />
      {children}
    </a>
  );
}
