"use client";

import { createContext, useContext, useState } from "react";
import { ExternalLink, Loader2, Sparkles, TriangleAlert, Wrench } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { RepositoryDeployButton } from "@/components/dashboard/repository-deploy-button";
import type { DeployFailureAnalysis } from "@/lib/claude/deploy-failure-analysis";
import {
  buildDeployFailureFixIssueDraft,
  parseRunIdFromRunUrl,
  type DeployFailureFixIssueDraft,
} from "@/lib/deploy-failure";
import { cn } from "@/lib/utils";
import type { DeployFailureIssueRef } from "@/types/branch-flow";

/**
 * 本番デプロイが失敗しているときに、失敗が見えている場所へそのまま出す帯（#2236）。
 *
 * **押せる場所を、失敗が見えている場所に置く。** 「本番へ再デプロイ」は#2020から
 * 「ブランチとPRの流れ」画面のリポジトリの節にあるが、そこは失敗の表示とは離れた行で、
 * PR詳細とIssue詳細には入口が無かった。落ちたことに気づいた人が、画面を移らずに
 * 出し直せるようにする。
 *
 * 出す先は3つで、**中身は同じもの**（見出しと説明だけ画面ごとに変える）。
 *
 * - ブランチ画面: 落ちた版の束の中
 * - PR詳細: 「デプロイ失敗」ピルの下
 * - Issue詳細: 自動起票したデプロイ失敗Issueのパネル（`deploy-failure-panel.tsx`）
 *
 * **ボタンは`RepositoryDeployButton`をそのまま使う。** 確認ダイアログ（押すと本番へ出るため
 * 必ず挟む）と`POST /api/repositories/deploy`の呼び出しを、3画面ぶん書き分けないため。
 */
/**
 * 「修正Issueを作成」の送り先（#3887）。**ここでは起票せず**、下書き入りの新規作成ダイアログを開くのは
 * シェル（`issue-deck-shell.tsx`）の仕事。帯は3画面にあるためcontextで渡す。提供されなければ
 * ボタンを出さない。
 */
export const DeployFailureFixIssueContext = createContext<
  ((draft: DeployFailureFixIssueDraft) => void) | undefined
>(undefined);

type AnalysisState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; analysis: DeployFailureAnalysis; jobName: string | null }
  | { status: "error"; message: string };

export type DeployFailureAlertProps = {
  repositoryFullName: string;
  /** 見出し。画面ごとに主語が変わる（「このPRの変更は本番へ出ていません」など） */
  title: string;
  /** 失敗した版（`1.4.2`）。分からなければnull */
  version?: string | null;
  /** いま本番に出ている版（`1.4.1`）。分からなければnull */
  previousVersion?: string | null;
  /** 自動で1回やり直したうえでの失敗か（`run_attempt >= 2`。#2134） */
  autoRetried?: boolean;
  /** 失敗したジョブ名。空なら行ごと出さない */
  failedJobs?: string[];
  /** 失敗した実行のログURL */
  runUrl?: string | null;
  /** 追跡している自動起票Issue。無ければリンクを出さない */
  failureIssue?: DeployFailureIssueRef | null;
  /** 説明の下に足す補足（Issue詳細だけが使う） */
  footer?: React.ReactNode;
  /** すでに起動済みで実行が現れるのを待っている最中か */
  isPending?: boolean;
  /** 起動に成功したあと */
  onTriggered?: () => void;
  /** ボタンを1行占有させる（スマホ幅） */
  compact?: boolean;
  className?: string;
};

export function DeployFailureAlert({
  repositoryFullName,
  title,
  version = null,
  previousVersion = null,
  autoRetried = false,
  failedJobs = [],
  runUrl = null,
  failureIssue = null,
  footer,
  isPending = false,
  onTriggered,
  compact = false,
  className,
}: DeployFailureAlertProps) {
  const openFixIssue = useContext(DeployFailureFixIssueContext);
  const [analysisState, setAnalysisState] = useState<AnalysisState>({ status: "idle" });
  const runId = parseRunIdFromRunUrl(runUrl);
  const analysis = analysisState.status === "done" ? analysisState.analysis : null;

  async function askAi() {
    if (runId === null || analysisState.status === "loading") return;
    const [owner, repo] = repositoryFullName.split("/");
    setAnalysisState({ status: "loading" });
    try {
      const res = await fetch("/api/repositories/deploy-failure/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, runId, version }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.analysis) {
        const message =
          data?.error === "not_configured"
            ? "AIが設定されていないため分析できません。"
            : data?.error === "no_failed_job"
              ? "失敗したジョブが見つかりませんでした。実行ログで確かめてください。"
              : "原因を分析できませんでした。時間をおいて押し直すか、実行ログを確かめてください。";
        setAnalysisState({ status: "error", message });
        return;
      }
      setAnalysisState({ status: "done", analysis: data.analysis, jobName: data.jobName ?? null });
    } catch {
      setAnalysisState({ status: "error", message: "通信に失敗しました。押し直してください。" });
    }
  }

  function createFixIssue() {
    openFixIssue?.(
      buildDeployFailureFixIssueDraft({
        repositoryFullName,
        version,
        runUrl,
        failedJobs,
        failureIssueNumber: failureIssue?.number ?? null,
        analysis,
      }),
    );
  }

  const versionLabel = version ? `v${version}` : "最新のmain";
  // **「1つ前の版のまま」で止めない。** 版が分かるなら書く。デプロイが失敗したときにいちばん
  // 知りたいのは「いま本番で動いているのは何か」なので、そこを曖昧にしない。
  const previousLabel = previousVersion ? `v${previousVersion}` : "1つ前の版";

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-destructive bg-destructive/10 p-3",
        className,
      )}
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold text-destructive">
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
        {title}
      </p>

      <p className="text-xs leading-relaxed">
        {versionLabel}のデプロイが失敗しました{autoRetried && "（自動で1回やり直しても失敗）"}。
        <span className="font-medium">本番は{previousLabel}のままです。</span>
        {failedJobs.length > 0 && (
          <>
            {" "}
            失敗したジョブ: <span className="font-mono">{failedJobs.join(", ")}</span>
          </>
        )}
      </p>

      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", compact && "flex-col items-stretch")}>
        <RepositoryDeployButton
          repositoryFullName={repositoryFullName}
          currentVersion={previousVersion}
          tone="destructive"
          block={compact}
          isPending={isPending}
          onTriggered={onTriggered}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {openFixIssue && (
            <button
              type="button"
              onClick={createFixIssue}
              className="inline-flex items-center gap-1 rounded-md border border-primary px-2 py-1 text-primary hover:bg-primary/10"
            >
              <Wrench className="size-3" aria-hidden="true" />
              修正Issueを作成
            </button>
          )}
          {runId !== null && (
            <button
              type="button"
              onClick={() => void askAi()}
              disabled={analysisState.status === "loading"}
              className="inline-flex items-center gap-1 rounded-md border border-primary px-2 py-1 text-primary hover:bg-primary/10 disabled:opacity-60"
            >
              {analysisState.status === "loading" ? (
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="size-3" aria-hidden="true" />
              )}
              {analysisState.status === "loading" ? "ログを読んでいます…" : "原因をAIに聞く"}
            </button>
          )}
          {runUrl && (
            // 実行ログはアプリ内に対応する画面が無いので別タブで開く（`DeployStateBadge`と同じ）
            <a
              href={runUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="size-3" aria-hidden="true" />
              実行ログを開く
            </a>
          )}
          {failureIssue && (
            <GithubReferenceLink
              href={failureIssue.htmlUrl}
              reference={{ repositoryFullName, number: failureIssue.number, kind: "issue" }}
              className="text-primary hover:underline"
            >
              デプロイ失敗 #{failureIssue.number}
            </GithubReferenceLink>
          )}
        </div>
      </div>

      {analysisState.status === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {analysisState.message}
        </p>
      )}

      {analysisState.status === "done" && (
        <div className="flex flex-col gap-2 border-t border-dashed border-destructive pt-2 text-xs leading-relaxed">
          <p className="font-semibold">
            失敗の原因{" "}
            <span className="rounded-full border px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
              AIの推定・ログ末尾から{analysisState.jobName ? `（${analysisState.jobName}）` : ""}
            </span>
          </p>
          <p>{analysisState.analysis.cause}</p>
          <p className="font-medium">
            {analysisState.analysis.retryMayFix
              ? "一時的な失敗の可能性があります。再デプロイで直るかもしれません。"
              : "再デプロイしても同じ場所で落ちる見込みです。修正が要ります。"}
          </p>
          {analysisState.analysis.advice && <p>{analysisState.analysis.advice}</p>}
          {analysisState.analysis.excerpt && (
            <pre className="overflow-x-auto rounded-md border bg-background p-2 font-mono text-[11px]">
              {analysisState.analysis.excerpt}
            </pre>
          )}
          {openFixIssue && (
            <div>
              <button
                type="button"
                onClick={createFixIssue}
                className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:opacity-90"
              >
                この内容で修正Issueを作成
              </button>
            </div>
          )}
        </div>
      )}

      {footer && <div className="text-xs leading-relaxed text-muted-foreground">{footer}</div>}
    </div>
  );
}
