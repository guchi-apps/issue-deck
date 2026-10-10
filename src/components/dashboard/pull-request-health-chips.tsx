"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { WorkflowRunProgressPanel } from "@/components/dashboard/workflow-run-progress-panel";
import {
  resolvePullRequestHealth,
  type PullRequestHealthCategory,
  type PullRequestHealthSlot,
  type PullRequestHealthSummary,
  type PullRequestHealthTone,
} from "@/lib/pull-request-health";
import { cn } from "@/lib/utils";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 状態の見た目。**色だけに頼らず、記号と文字を常に出す**（スマホはホバーできない）。
 * 色の意味は全画面で揃える（#4293）: 琥珀＝人の承認・確認・操作待ち、赤＝失敗・要修正・問題による停止、
 * 紫＝実行中、灰＝実行待ち・未確認・意図的な停止、緑＝成功・完了。
 */
const TONE_CLASS: Record<PullRequestHealthTone, string> = {
  bad: "border-destructive/60 bg-destructive/10 text-destructive",
  wait: "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  run: "border-violet-500/60 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  ok: "border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
  idle: "border-border bg-muted/40 text-muted-foreground",
};

const SLOT_CLASS =
  "inline-flex min-h-7 shrink-0 items-center gap-0.5 rounded-sm border px-1 py-0.5 text-xs font-medium whitespace-nowrap max-sm:text-[11px] sm:gap-1 sm:px-2";

const INTERACTIVE_CLASS =
  "transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function SlotBody({ slot }: { slot: PullRequestHealthSlot }) {
  return (
    <>
      <span aria-hidden="true">{slot.icon}</span>
      {slot.label}
    </>
  );
}

function BreakdownToggle({ open }: { open: boolean }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return <Icon className="size-3 shrink-0" aria-hidden="true" />;
}

/**
 * 展開したPR行に並べる、CI・レビュー・競合の状態を1行で、自動修正の状況を別行で（#4015・#4293）。
 *
 * 判定は[`lib/pull-request-health.ts`](../../lib/pull-request-health.ts)が持つ。**CI・レビューの枠は
 * 押すと内訳（#3662・#4024）が枠の下へ開き**、実行ログへのリンクがある枠はそのログへ、それ以外の
 * 詳細のある枠はアプリ内のPR詳細へ進む。3項目は文字拡大で幅が足りなくなったときだけ折り返し、
 * 切り捨てない。
 */
export function PullRequestHealthRow({ pullRequest }: { pullRequest: PullRequestSummary }) {
  const [ciOpen, setCiOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const health = resolvePullRequestHealth(pullRequest);
  if (health.slots.length === 0) return null;

  const repairSlot = health.slots.find((slot) => slot.key === "repair");
  const checkSlots = health.slots.filter((slot) => slot.key !== "repair");

  const renderSlot = (slot: PullRequestHealthSlot) => {
    const title = `${slot.columnLabel}: ${slot.title}`;
    const className = cn(SLOT_CLASS, TONE_CLASS[slot.tone]);
    if (slot.detail === "ci-breakdown" || slot.detail === "agent-breakdown") {
      const isCi = slot.detail === "ci-breakdown";
      const open = isCi ? ciOpen : agentOpen;
      return (
        <button
          key={slot.key}
          type="button"
          onClick={() => (isCi ? setCiOpen(!ciOpen) : setAgentOpen(!agentOpen))}
          aria-expanded={open}
          title={title}
          className={cn(className, INTERACTIVE_CLASS)}
        >
          <SlotBody slot={slot} />
          <BreakdownToggle open={open} />
        </button>
      );
    }
    if (slot.href) {
      return (
        <a
          key={slot.key}
          href={slot.href}
          target="_blank"
          rel="noopener noreferrer"
          title={`${title}（クリックで実行ログを開きます）`}
          className={cn(className, "hover:underline")}
        >
          <SlotBody slot={slot} />
        </a>
      );
    }
    if (slot.detail === "pull-request") {
      return (
        <GithubReferenceLink
          key={slot.key}
          href={pullRequest.htmlUrl}
          reference={{
            repositoryFullName: pullRequest.repositoryFullName,
            number: pullRequest.number,
            kind: "pull",
          }}
          title={`${title}（クリックでPRの詳細を開きます）`}
          className={cn(className, "hover:underline")}
        >
          <SlotBody slot={slot} />
        </GithubReferenceLink>
      );
    }
    return (
      <span key={slot.key} className={className} title={title}>
        <SlotBody slot={slot} />
      </span>
    );
  };

  return (
    <div className="flex min-w-0 basis-full flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1" aria-label="CI・レビュー・競合の状態">
        {checkSlots.map(renderSlot)}
      </div>
      {/* 内訳は、開いた枠の直下へ出す（初期は閉じる） */}
      {agentOpen && (
        <ul className="flex flex-col gap-1 text-xs" aria-label="エージェント別のレビュー内訳">
          {checkSlots
            .find((slot) => slot.key === "review")
            ?.breakdown?.map((row) => (
              <li key={row.agentLabel} className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-muted-foreground">{row.agentLabel}</span>
                <span className={cn(SLOT_CLASS, TONE_CLASS[row.tone])}>
                  <span aria-hidden="true">{row.icon}</span>
                  {row.label}
                </span>
              </li>
            ))}
        </ul>
      )}
      {ciOpen && (
        <WorkflowRunProgressPanel
          repositoryFullName={pullRequest.repositoryFullName}
          runId={pullRequest.ciRunId}
          open={ciOpen}
          title="CIの内訳"
          checks={pullRequest.ciChecks}
          className="max-w-2xl"
        />
      )}
      {/* 自動修正中・再検証待ち・修正停止・ラウンド数は3項目と混ぜず別行に置く */}
      {repairSlot && <div className="flex flex-wrap items-center gap-1">{renderSlot(repairSlot)}</div>}
    </div>
  );
}

/**
 * 畳んだ行に出す件数の並び。**問題（赤・琥珀）を先に、進行状況（primary）を後に**置く。
 * 成功状態は出さない（長いバッジを並べない。#2172）。0件のカテゴリは出さない。
 *
 * 件数は該当するopen PR数で、同じPRが複数に数えられるため合計はPR数ではない。
 */
const CHIP_DEFS: {
  category: PullRequestHealthCategory;
  label: string;
  icon: string;
  tone: PullRequestHealthTone;
  description: string;
}[] = [
  { category: "ci-failed", label: "CI失敗", icon: "✕", tone: "bad", description: "CIが失敗しているPR" },
  { category: "review-changes-requested", label: "レビュー要修正", icon: "✕", tone: "bad", description: "レビューが修正を求めているPR" },
  { category: "conflict", label: "コンフリクト", icon: "✕", tone: "bad", description: "コンフリクトしているPR" },
  { category: "review-failed", label: "レビュー失敗", icon: "✕", tone: "bad", description: "レビューのジョブが失敗したPR" },
  { category: "repair-stopped", label: "修正停止", icon: "■", tone: "bad", description: "問題により自動修正が止まったPR" },
  { category: "review-needs-check", label: "レビュー要確認", icon: "△", tone: "wait", description: "レビューが人の確認を求めているPR" },
  { category: "repair-fixing", label: "修正中", icon: "⚙", tone: "run", description: "自動修正中のPR" },
  { category: "revalidating", label: "再検証待ち", icon: "◔", tone: "idle", description: "新しいコミットの検証待ちのPR" },
  { category: "ci-running", label: "CI実行中", icon: "●", tone: "run", description: "CIが完了していないPR" },
  { category: "review-running", label: "レビュー中", icon: "●", tone: "run", description: "レビュー実行中のPR" },
];

/** `PullRequestHealthSummaryChips`が1つ以上描画するか（畳んだ行で空のバッジ行を作らないため） */
export function hasPullRequestHealthChips(summary: PullRequestHealthSummary): boolean {
  return CHIP_DEFS.some((def) => summary.counts[def.category] > 0);
}

export function PullRequestHealthSummaryChips({ summary }: { summary: PullRequestHealthSummary }) {
  const chips = CHIP_DEFS.filter((def) => summary.counts[def.category] > 0);
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((def) => {
        const count = summary.counts[def.category];
        return (
          <span
            key={def.category}
            title={`${def.description}: ${count}件`}
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-xs font-medium tabular-nums",
              TONE_CLASS[def.tone],
            )}
          >
            <span aria-hidden="true">{def.icon}</span>
            <span>{def.label}</span>
            <span>{count}</span>
          </span>
        );
      })}
    </>
  );
}
