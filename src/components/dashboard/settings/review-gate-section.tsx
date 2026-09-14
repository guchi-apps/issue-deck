"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, ExternalLink, Info, RefreshCw } from "lucide-react";

import { FleetRepositoryRow } from "@/components/dashboard/fleet-repository-row";
import { Button } from "@/components/ui/button";
import type { ReviewGateOverview, ReviewGateRepository } from "@/lib/github/review-gates";
import {
  BUILTIN_RISK_PATTERNS,
  isChangedFromDefault,
  REVIEW_INPUT_DEFAULTS,
  REVIEW_SAMPLE_SIZE,
  summarizeReviewOutcomes,
  type ReviewOutcome,
  type ReviewScalarInput,
} from "@/lib/review-gate-config";

/**
 * 設定＞フリート運用の「Claudeレビューの実行条件」（#2948）。
 *
 * リポジトリごとのcallerの`with:`（閾値・risk-paths・merge-policy・dependency-check）と、
 * 直近のIssue PRで`claude-review`が走ったかを並べる。**雛形のままのrisk-pathsを注意色で
 * 先頭に出す**——パス名から判別できない領域に触れる小さなPRがレビューされないまま
 * developへ入っていることに、callerを開かずに気づけるようにするため（ops-dashboard#233）。
 */
export function ReviewGateSection({ open }: { open: boolean }) {
  const [overview, setOverview] = useState<ReviewGateOverview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/review-gates");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ReviewGateOverview;
        if (!cancelled) setOverview(data);
      } catch (cause) {
        if (!cancelled) setError(`取得できませんでした（${String(cause)}）`);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, reloadCount]);

  const repositories = overview?.repositories ?? [];
  const templateCount = repositories.filter((r) => r.config.riskPathsState === "template").length;

  return (
    <div className="flex flex-col gap-2.5">
      {overview && templateCount > 0 && (
        <p className="flex gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-2.5 py-2 text-xs dark:border-amber-500/40 dark:bg-amber-500/10">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
          <span>
            <span className="font-medium">{templateCount}件がrisk-pathsを雛形のまま使っています。</span>
            パス名から判別できない領域（認証・トークンを扱う処理など）に触れても、変更が閾値を下回るとレビューされません。
          </span>
        </p>
      )}

      {overview && !overview.templateAvailable && repositories.length > 0 && (
        <p className="text-xs text-muted-foreground">
          配布雛形を取得できなかったため、risk-pathsが雛形のままかどうかは判定していません。
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <span>
            既定値: {REVIEW_INPUT_DEFAULTS["review-file-threshold"]}ファイル /{" "}
            {REVIEW_INPUT_DEFAULTS["review-line-threshold"]}行 · merge-policy{" "}
            {REVIEW_INPUT_DEFAULTS["merge-policy"]} · dependency-check{" "}
            {REVIEW_INPUT_DEFAULTS["dependency-check"]}
          </span>
          <OutcomeLegend />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={isLoading}
          onClick={() => setReloadCount((count) => count + 1)}
        >
          <RefreshCw className={isLoading ? "animate-spin" : undefined} />
          再取得
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {isLoading && !overview && <p className="text-xs text-muted-foreground">取得中...</p>}
      {overview && repositories.length === 0 && (
        <p className="text-xs text-muted-foreground">
          develop向けレビューのcaller（claude-review-develop.yml）を持つリポジトリがありません。
        </p>
      )}

      {repositories.length > 0 && (
        <ul>
          {repositories.map((repository) => (
            <ReviewGateRow
              key={repository.fullName}
              repository={repository}
              open={expanded === repository.fullName}
              onToggle={() =>
                setExpanded((current) => (current === repository.fullName ? null : repository.fullName))
              }
            />
          ))}
        </ul>
      )}

      <p className="text-[11px] text-muted-foreground">
        release/・workflow-tag/ などIssue番号の無いPRは常にレビューされるため数えていません。
        .github/workflows/ を変えるPRは、Claudeを実行しないまま成功で終わるため「実行」に数えられます。
        判定エラーはrisk-checkが失敗したPRで、callerのrisk-pathsの書式誤りが疑われます。
      </p>
    </div>
  );
}

function OutcomeLegend() {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
      <span>直近のIssue PR {REVIEW_SAMPLE_SIZE}件（左が古い）</span>
      <span className="inline-flex items-center gap-1">
        <OutcomeTick outcome="reviewed" />
        レビュー実行
      </span>
      <span className="inline-flex items-center gap-1">
        <OutcomeTick outcome="skipped" />
        skip
      </span>
      <span className="inline-flex items-center gap-1">
        <OutcomeTick outcome="error" />
        判定エラー
      </span>
      <span className="inline-flex items-center gap-1">
        <OutcomeTick outcome="failed" />
        失敗・打ち切り・実行中
      </span>
    </span>
  );
}

const OUTCOME_LABEL: Record<ReviewOutcome, string> = {
  reviewed: "レビュー実行",
  skipped: "skip",
  error: "判定エラー（risk-checkが失敗）",
  failed: "失敗・打ち切り",
  pending: "実行中",
};

function OutcomeTick({ outcome }: { outcome: ReviewOutcome }) {
  if (outcome === "reviewed") return <i className="block h-3 w-[5px] rounded-[1px] bg-foreground" />;
  if (outcome === "skipped") {
    return <i className="block h-3 w-[5px] rounded-[1px] ring-1 ring-inset ring-muted-foreground/50" />;
  }
  if (outcome === "error") return <i className="block h-3 w-[5px] rounded-[1px] bg-destructive" />;
  return <i className="mt-1 block h-1 w-[5px] rounded-[1px] bg-muted-foreground/40" />;
}

function RiskPathsChip({ repository }: { repository: ReviewGateRepository }) {
  const { config } = repository;
  const base = "shrink-0 whitespace-nowrap rounded-full border px-1.5 text-[11px] leading-[18px]";
  switch (config.riskPathsState) {
    case "template":
      return (
        <span className={`${base} border-amber-300/70 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10`}>
          雛形のまま
        </span>
      );
    case "custom":
      return <span className={base}>固有パス +{config.customRiskPathCount}</span>;
    case "replaced":
      return <span className={base}>固有パスのみ {config.customRiskPathCount}件</span>;
    case "unknown":
      return <span className={`${base} text-muted-foreground`}>risk-paths {config.riskPaths.length}件</span>;
    case "none":
      return <span className={`${base} text-muted-foreground`}>内蔵パターンのみ</span>;
  }
}

function StateIcon({ repository }: { repository: ReviewGateRepository }) {
  const state = repository.config.riskPathsState;
  if (state === "template") return <AlertTriangle className="size-3.5 text-amber-500" />;
  if (state === "custom" || state === "replaced") {
    return <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-500" />;
  }
  return <Info className="size-3.5 text-muted-foreground" />;
}

function OutcomeMeter({ repository }: { repository: ReviewGateRepository }) {
  const summary = summarizeReviewOutcomes(repository.outcomes);
  if (repository.outcomes.length === 0) {
    return <span className="text-[11px] text-muted-foreground">Issue PRなし</span>;
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <span className="inline-flex gap-0.5" aria-hidden="true">
        {repository.outcomes.map((item) => (
          <span key={item.number} title={`#${item.number} ${OUTCOME_LABEL[item.outcome]}`}>
            <OutcomeTick outcome={item.outcome} />
          </span>
        ))}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
        レビュー <span className="text-foreground">{summary.reviewed}</span>/{summary.counted}
      </span>
      {summary.errors > 0 && (
        <span className="text-[11px] text-destructive tabular-nums">判定エラー {summary.errors}</span>
      )}
    </span>
  );
}

function InputValue({
  repository,
  inputKey,
  unit = "",
}: {
  repository: ReviewGateRepository;
  inputKey: ReviewScalarInput;
  unit?: string;
}) {
  const input = repository.config.inputs[inputKey];
  const changed = isChangedFromDefault(inputKey, input);
  return (
    <span className={changed ? "font-medium text-foreground" : undefined}>
      {input.value}
      {unit}
    </span>
  );
}

function thresholdNote(repository: ReviewGateRepository): string {
  const { inputs } = repository.config;
  const keys: ReviewScalarInput[] = ["review-file-threshold", "review-line-threshold"];
  if (keys.some((key) => isChangedFromDefault(key, inputs[key]))) return "（変更あり）";
  if (keys.some((key) => inputs[key].explicit)) return "（明示・既定と同じ）";
  return "（既定）";
}

function ReviewGateRow({
  repository,
  open,
  onToggle,
}: {
  repository: ReviewGateRepository;
  open: boolean;
  onToggle: () => void;
}) {
  const { config } = repository;
  const lockFiles = config.inputs["lock-files"];

  return (
    <FleetRepositoryRow
      icon={<StateIcon repository={repository} />}
      fullName={repository.fullName}
      result={
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <RiskPathsChip repository={repository} />
          <OutcomeMeter repository={repository} />
        </span>
      }
      expansion={
        <div className="flex flex-col gap-1">
          <span className="flex flex-wrap gap-x-2.5 text-muted-foreground">
            <span>
              閾値 <InputValue repository={repository} inputKey="review-file-threshold" unit="ファイル" /> /{" "}
              <InputValue repository={repository} inputKey="review-line-threshold" unit="行" />
              {thresholdNote(repository)}
            </span>
            <span>
              merge-policy <InputValue repository={repository} inputKey="merge-policy" />
            </span>
            <span>
              dependency-check <InputValue repository={repository} inputKey="dependency-check" />
            </span>
            {lockFiles.explicit && (
              <span>
                差分から除外 <span className="font-mono">{lockFiles.value}</span>
              </span>
            )}
          </span>
          {open && <RiskPathsDetail repository={repository} />}
        </div>
      }
      action={
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="inline-flex shrink-0 items-center gap-0.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {open ? "閉じる" : "内訳"}
          <ChevronRight className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
      }
    />
  );
}

function RiskPathsDetail({ repository }: { repository: ReviewGateRepository }) {
  const { config } = repository;
  return (
    <div className="mt-1 flex flex-col gap-1.5 rounded-md bg-muted p-2">
      <span className="text-[11px] font-medium text-muted-foreground">
        risk-paths（{config.riskPaths.length}件）
      </span>
      {config.riskPaths.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">risk-pathsを渡していません。</p>
      ) : (
        <ul className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-0.5">
          {config.riskPaths.map((line, index) => (
            <li key={`${index}-${line.pattern}`} className="contents">
              <span
                className={`whitespace-nowrap rounded border px-1 text-[10px] ${
                  line.fromTemplate === false
                    ? "border-emerald-600/60 text-emerald-700 dark:text-emerald-400"
                    : "border-muted-foreground/40 text-muted-foreground"
                }`}
              >
                {line.fromTemplate === null ? "行" : line.fromTemplate ? "雛形" : "固有"}
              </span>
              <span className="font-mono text-[11px] [overflow-wrap:anywhere]">{line.pattern}</span>
              {line.reason && (
                <span className="col-start-2 mb-1 text-[11px] text-muted-foreground">{line.reason}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {config.riskPathsState === "replaced" && (
        <p className="text-[11px] text-muted-foreground">
          雛形の共通パスのうち{config.missingTemplateRiskPathCount}件は含まれていません。
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        常に判定される内蔵パターン:{" "}
        <span className="font-mono">{BUILTIN_RISK_PATTERNS.join(" ")}</span>
      </p>
      <a
        className="inline-flex items-center gap-0.5 self-start text-[11px] underline underline-offset-2"
        href={repository.callerUrl}
        target="_blank"
        rel="noreferrer"
      >
        callerを開く
        <ExternalLink className="size-3" />
      </a>
    </div>
  );
}
