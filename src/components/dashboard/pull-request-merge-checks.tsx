"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";

import type { MergeCheckItem, MergeCheckTone } from "@/lib/pull-request-merge-checks";
import { cn } from "@/lib/utils";

const TONE_TEXT: Record<MergeCheckTone, string> = {
  ok: "text-green-700 dark:text-green-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-destructive",
  run: "text-blue-700 dark:text-blue-400",
  muted: "text-muted-foreground",
};

/**
 * 本番マージ確認ダイアログのPR行に出す5チェック（#4305）。
 *
 * 塗りのチップにはせず、既存の検証区分と同じ「記号＋文字」で出す。ラベルを上・状態を下に積んで
 * 5項目を横1行に収め、320px級だけ「CI・計画・コード」＋「全体〔共通〕・競合」の2段へ折り返す
 * （横スクロールにしない）。色に頼らず、記号と日本語の状態で読める。各項目は44px以上のタップ領域で、
 * 押すと行の下に詳細（正式名称・状態・判定対象・理由・証跡）を開く。
 */
export function PullRequestMergeChecks({
  checks,
  issueUrl,
  onOpenPullRequest,
  onOpenOverall,
}: {
  checks: readonly MergeCheckItem[];
  /** 関連Issueの画面URL（`issue`の証跡）。無ければ証跡を出さない */
  issueUrl: string | null;
  onOpenPullRequest: (() => void) | null;
  onOpenOverall: () => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = checks.find((check) => check.key === openKey) ?? null;

  return (
    <div className="px-3 pb-1.5">
      <ul className="grid grid-cols-5 max-[359px]:grid-cols-6">
        {checks.map((check, index) => (
          <li
            key={check.key}
            className={cn(
              "min-w-0",
              // 320px級は3＋2の2段。下段の2項目は幅を広げて全体〔共通〕の名前を折り返さない
              "max-[359px]:col-span-2",
              index >= 3 && "max-[359px]:col-span-3",
            )}
          >
            <button
              type="button"
              aria-expanded={openKey === check.key}
              aria-label={`${check.fullName}: ${check.state}`}
              onClick={() => setOpenKey(openKey === check.key ? null : check.key)}
              className={cn(
                "flex min-h-11 w-full flex-col items-start justify-center rounded px-1 py-0.5 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
                openKey === check.key && "bg-muted",
              )}
            >
              <span
                className={cn(
                  "text-[10px] leading-4 whitespace-nowrap text-muted-foreground",
                  check.common && "font-bold text-foreground",
                )}
              >
                {check.shortLabel}
              </span>
              <span className={cn("text-[11px] leading-4 font-bold whitespace-nowrap", TONE_TEXT[check.tone])}>
                <span aria-hidden="true">{check.mark}</span> {check.state}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {open && (
        <div role="group" aria-label={`${open.fullName}の詳細`} className="mt-1 rounded border bg-muted/30 px-2.5 py-2 text-[11.5px]">
          <p className="font-semibold">{open.fullName}</p>
          <dl className="mt-1 grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5">
            <dt className="text-muted-foreground">状態</dt>
            <dd className={cn("font-bold", TONE_TEXT[open.tone])}>
              <span aria-hidden="true">{open.mark}</span> {open.state}
            </dd>
            <dt className="text-muted-foreground">判定対象</dt>
            <dd className="break-words">{open.target}</dd>
            <dt className="text-muted-foreground">理由・指摘</dt>
            <dd className="break-words">
              {open.key === "all"
                ? `${open.reason ?? "なし"}（指摘本文は全体レビューの詳細で確認します）`
                : (open.reason ?? "なし")}
            </dd>
          </dl>
          {open.evidence && (
            <p className="mt-1.5">
              {open.evidence.kind === "overall" ? (
                <button type="button" onClick={onOpenOverall} className="min-h-8 text-primary underline-offset-2 hover:underline">
                  {open.evidence.label} ›
                </button>
              ) : open.evidence.kind === "issue" ? (
                issueUrl && (
                  <a
                    href={issueUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-8 items-center gap-1 text-primary underline-offset-2 hover:underline"
                  >
                    {open.evidence.label}
                    <ExternalLink aria-hidden className="size-3" />
                  </a>
                )
              ) : (
                onOpenPullRequest && (
                  <button type="button" onClick={onOpenPullRequest} className="min-h-8 text-primary underline-offset-2 hover:underline">
                    {open.evidence.label} ›
                  </button>
                )
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
