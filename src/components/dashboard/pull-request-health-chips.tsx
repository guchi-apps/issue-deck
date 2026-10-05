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
 * 色は既存のバッジに揃える: 赤＝人が直す、琥珀＝人が確認する、primary＝待てば進む。
 */
const TONE_CLASS: Record<PullRequestHealthTone, string> = {
  bad: "border-destructive/60 bg-destructive/10 text-destructive",
  warn: "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  run: "border-primary/60 bg-primary/10 text-primary",
  ok: "border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400",
  idle: "border-border bg-background text-muted-foreground",
};

const SLOT_CLASS =
  "inline-flex min-h-7 shrink-0 items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium";

function SlotBody({ slot }: { slot: PullRequestHealthSlot }) {
  return (
    <>
      <span aria-hidden="true">{slot.icon}</span>
      {slot.label}
    </>
  );
}

/**
 * 展開したPR行に並べる、CI・レビュー・コンフリクト・自動修正の状態（#4015）。
 *
 * 判定は[`lib/pull-request-health.ts`](../../lib/pull-request-health.ts)が持つ。**CIの枠は
 * 押すと内訳（#3662）が開き**、実行ログへのリンクがある枠はそのログへ、それ以外の詳細のある枠は
 * アプリ内のPR詳細へ進む。
 */
export function PullRequestHealthRow({ pullRequest }: { pullRequest: PullRequestSummary }) {
  const [ciOpen, setCiOpen] = useState(false);
  const health = resolvePullRequestHealth(pullRequest);
  if (health.slots.length === 0) return null;

  return (
    <>
      {health.slots.map((slot) => {
        const title = `${slot.columnLabel}: ${slot.title}`;
        const className = cn(SLOT_CLASS, TONE_CLASS[slot.tone]);
        if (slot.detail === "ci-breakdown") {
          return (
            <button
              key={slot.key}
              type="button"
              onClick={() => setCiOpen(!ciOpen)}
              aria-expanded={ciOpen}
              title={title}
              className={cn(
                className,
                "transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <SlotBody slot={slot} />
              {ciOpen ? (
                <ChevronDown className="size-3" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3" aria-hidden="true" />
              )}
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
      })}
      {ciOpen && (
        <WorkflowRunProgressPanel
          repositoryFullName={pullRequest.repositoryFullName}
          runId={pullRequest.ciRunId}
          open={ciOpen}
          title="CIの内訳"
          checks={pullRequest.ciChecks}
          className="mt-1 max-w-2xl basis-full"
        />
      )}
    </>
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
  { category: "review-needs-check", label: "レビュー要確認", icon: "△", tone: "warn", description: "レビューが要確認・失敗のPR" },
  { category: "repair-stopped", label: "修正停止", icon: "■", tone: "warn", description: "自動修正が止まったPR" },
  { category: "repair-fixing", label: "修正中", icon: "⚙", tone: "run", description: "自動修正中のPR" },
  { category: "revalidating", label: "再検証待ち", icon: "◔", tone: "run", description: "新しいコミットの検証待ちのPR" },
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
