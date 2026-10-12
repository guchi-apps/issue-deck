"use client";

import { useState } from "react";

import type { MergeCheckItem, MergeCheckTone } from "@/lib/pull-request-merge-checks";
import { releaseVersionFromRef } from "@/lib/pull-request-primary-state";
import { describeCandidateTarget, type ReleaseCandidate } from "@/lib/release-candidate-checks";
import { cn } from "@/lib/utils";

const TONE_TEXT: Record<MergeCheckTone, string> = {
  ok: "text-green-700 dark:text-green-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-destructive",
  run: "text-blue-700 dark:text-blue-400",
  muted: "text-muted-foreground",
};

/**
 * PR詳細・PR一覧・ブランチ画面・本番マージ確認の一覧に出す6チェック（#4366。#4305の5項目の後継）。
 *
 * 塗りのチップにはせず、既存の検証区分と同じ「記号＋文字」で出す。ラベルを上・状態を下に積み、
 * スマホ幅は3項目ずつの2段（CI・コード・競合／全体・統合・Mac）、広い画面は横1行にする
 * （横スクロール・ホバーに頼らない）。色に頼らず、記号と日本語の状態で読める。各項目は44px以上の
 * タップ領域で、押すと下に詳細（正式名称・状態・判定対象・理由・証跡）を開く。
 * 共通結果（全体・統合・Mac）は、判定対象の候補PRとSHAを常に添える。複数の候補に含まれる変更は
 * 候補を選べる。
 */
export function PullRequestMergeChecks({
  checks,
  candidate,
  choices = [],
  onSelectCandidate,
  onOpenPullRequest,
  onOpenCandidate,
  grouped = false,
  showCandidateNote = false,
  pullRequestEvidenceLabel,
  className,
}: {
  checks: readonly MergeCheckItem[];
  /** 共通結果の判定対象の候補。無ければ「リリース未作成」などの理由が各項目に出る */
  candidate: ReleaseCandidate | null;
  /** 対象にできる候補（2件以上のとき選択肢を出す） */
  choices?: readonly ReleaseCandidate[];
  onSelectCandidate?: (candidateNumber: number) => void;
  onOpenPullRequest: (() => void) | null;
  /** 共通結果の詳細（候補PRの詳細）を開く */
  onOpenCandidate: ((candidateNumber: number) => void) | null;
  /**
   * 「このPR（CI・コード・競合）」と「リリース候補（全体・統合・Mac）」の2グループに分けて出す（#4427）。
   * 一覧・通常PR詳細が使う。省略時は従来どおり6項目を1つの並びで出す（ブランチ画面・本番マージ確認）
   */
  grouped?: boolean;
  /** `grouped`のとき、候補が無い・読めない理由を共通説明として1回出す（詳細向け。一覧は見出しの印だけ） */
  showCandidateNote?: boolean;
  /** このPRの証跡の導線の文言を差し替える（詳細では「PR詳細を開く」が自画面を指してしまうため） */
  pullRequestEvidenceLabel?: string;
  className?: string;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = checks.find((check) => check.key === openKey) ?? null;

  const renderButton = (check: MergeCheckItem) => (
    <div key={check.key} className="min-w-0">
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
            "text-sm leading-5 text-muted-foreground",
            !grouped && check.common && "font-bold text-foreground",
          )}
        >
          {grouped ? check.shortLabel.replace("〔共通〕", "") : check.shortLabel}
        </span>
        <span className={cn("text-sm leading-5 font-bold", TONE_TEXT[check.tone])}>
          <span aria-hidden="true">{check.mark}</span> {check.state}
        </span>
      </button>
    </div>
  );

  const own = checks.filter((check) => !check.common);
  const common = checks.filter((check) => check.common);
  const candidateLabel = candidate
    ? [releaseVersionFromRef(candidate.headRef), `#${candidate.number}`].filter(Boolean).join("・")
    : null;
  const candidateNote = common[0]?.reason ?? null;

  return (
    <div className={cn("px-3 pb-1.5", className)} data-testid="pull-request-checks">
      {grouped ? (
        <div className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2">
          <section aria-label="このPRのチェック" className="min-w-0">
            <h3 className="px-1 text-sm leading-5 font-semibold text-muted-foreground">
              このPR<span className="font-normal">（CI・コード・競合）</span>
            </h3>
            <div className="grid grid-cols-3">{own.map(renderButton)}</div>
          </section>
          <section aria-label="リリース候補のチェック" className="min-w-0">
            <h3 className="px-1 text-sm leading-5 font-semibold text-muted-foreground">
              リリース候補
              <span className="font-normal">
                {candidateLabel ? `（${candidateLabel}）` : "（全体・統合・Mac）"}
              </span>
            </h3>
            <div className="grid grid-cols-3">{common.map(renderButton)}</div>
          </section>
        </div>
      ) : (
        <div className="grid grid-cols-3 xl:grid-cols-6">{checks.map(renderButton)}</div>
      )}

      {grouped && showCandidateNote && !candidate && candidateNote && (
        <p className="mt-0.5 px-1 text-xs leading-4 text-muted-foreground" data-testid="release-candidate-note">
          リリース候補: {candidateNote}。通常PRのマージ条件には影響しません。
        </p>
      )}

      {!grouped && candidate && (
        <p className="mt-0.5 px-1 text-xs leading-4 text-muted-foreground">
          共通結果の対象: {describeCandidateTarget(candidate)}
        </p>
      )}

      {open && (
        <div role="group" aria-label={`${open.fullName}の詳細`} className="mt-1 rounded border bg-muted/30 px-2.5 py-2 text-sm">
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
                ? `${open.reason ?? "なし"}（指摘本文は候補PRの全体レビューの詳細で確認します）`
                : (open.reason ?? "なし")}
            </dd>
          </dl>
          {open.common && choices.length > 1 && onSelectCandidate && (
            <p className="mt-1.5">
              <label className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">対象の候補</span>
                <select
                  value={candidate?.number ?? ""}
                  onChange={(event) => onSelectCandidate(Number(event.target.value))}
                  className="min-h-8 max-w-full rounded border bg-background px-1.5"
                >
                  {choices.map((choice) => (
                    <option key={choice.number} value={choice.number}>
                      {`#${choice.number} ${choice.headRef}（${choice.headSha.slice(0, 7)}）`}
                    </option>
                  ))}
                </select>
              </label>
            </p>
          )}
          {open.evidence && (
            <p className="mt-1.5">
              {open.evidence.kind === "candidate"
                ? onOpenCandidate &&
                  open.candidateNumber !== null && (
                    <button
                      type="button"
                      onClick={() => onOpenCandidate(open.candidateNumber as number)}
                      className="min-h-8 text-primary underline-offset-2 hover:underline"
                    >
                      {open.evidence.label} ›
                    </button>
                  )
                : onOpenPullRequest && (
                    <button
                      type="button"
                      onClick={onOpenPullRequest}
                      className="min-h-8 text-primary underline-offset-2 hover:underline"
                    >
                      {pullRequestEvidenceLabel ?? open.evidence.label} ›
                    </button>
                  )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
