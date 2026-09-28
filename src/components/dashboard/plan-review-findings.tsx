"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, ScanSearch } from "lucide-react";

import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildPlanReviewDecisionRequestText,
  PLAN_REVIEW_REFLECT_REQUEST_TEXT,
} from "@/lib/dispatch/session-plan-request";
import type {
  ParsedPlanReview,
  PlanReviewFinding,
  PlanReviewRecommendationKind,
} from "@/lib/github/plan-review";
import { cn } from "@/lib/utils";

/**
 * 計画レビュー（G1・`<!-- supervisor:plan-review -->`）を、推奨と指摘ごとのカードに分けて出し、
 * 指摘ごとに「反映する／見送る」を選んで送らせる（#3554）。
 *
 * **これまで画面に出ていたのは「計画レビューが届いています」の1行と、全部を任せる
 * 「レビューを反映して計画を出し直す」だけ**（#3521）で、何を指摘されたのかはコメント欄まで
 * 下りて読むしかなく、どれを取り込ませるかも選べなかった。
 *
 * **送る先は呼び出し側が決める。** ローカルセッションの計画は計画承認パネルの「修正」
 * （`decidePlan`の`revise`）、無人実行の計画は承認欄の「修正」と同じ`@claude`コメント
 * （`handleReject`）。ここは送る文を組み立てるだけで、どちらの経路かは知らない。
 *
 * **既定は全件「反映する」。** 従来の一括ボタンと同じ1タップで送れ、見送りたいものだけ切り替える。
 * **指摘に分けられなかったレビューは本文を1枚で出し、従来の一括の依頼文に戻す**
 * （書式は自由記述の慣習頼みなので、分けられないときに何も押せなくならないようにする）。
 */
export function PlanReviewFindings({
  review,
  reviewedAtLabel,
  repositoryFullName,
  submitLabel,
  fallbackSubmitLabel,
  disabled = false,
  isSubmitting = false,
  onSubmit,
}: {
  review: ParsedPlanReview;
  /** レビューコメントの投稿日時の表示（`IssueComment.createdAtLabel`）。無ければ出さない */
  reviewedAtLabel?: string;
  repositoryFullName?: string;
  /** 指摘ごとの判断を送るボタンの文言（例: 「選んだ指摘で計画を出し直す」） */
  submitLabel: string;
  /** 指摘に分けられなかったときの一括ボタンの文言（例: 「レビューを反映して計画を出し直す」） */
  fallbackSubmitLabel: string;
  disabled?: boolean;
  isSubmitting?: boolean;
  onSubmit: (text: string) => void | Promise<void>;
}) {
  // 番号ごとの判断。**無い番号は「反映する」**として扱う（既定を全件反映にするため）
  const [skipped, setSkipped] = useState<Record<number, boolean>>({});
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [isBodyOpen, setIsBodyOpen] = useState(false);

  const { findings } = review;
  const hasFindings = findings.length > 0;
  const skipCount = findings.filter((finding) => skipped[finding.number]).length;
  const applyCount = findings.length - skipCount;

  function submitDecisions() {
    void onSubmit(
      buildPlanReviewDecisionRequestText(
        findings.map((finding) => ({
          number: finding.number,
          title: finding.title,
          decision: skipped[finding.number] ? "skip" : "apply",
          reason: skipped[finding.number] ? reasons[finding.number] : undefined,
        })),
      ),
    );
  }

  return (
    <section className="overflow-hidden rounded-md border bg-card" aria-label="計画レビュー">
      <header className="flex flex-wrap items-center gap-2 border-b bg-blue-500/10 px-3 py-2">
        <h4 className="text-sm font-semibold text-blue-700 dark:text-blue-300">計画レビュー（G1）</h4>
        <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
          {hasFindings ? `指摘 ${findings.length}件` : review.noFindings ? "指摘なし" : "本文のみ"}
        </span>
        {reviewedAtLabel && (
          <span className="ml-auto text-[11px] text-muted-foreground">{reviewedAtLabel}</span>
        )}
      </header>

      {review.recommendation && (
        <div className="flex flex-wrap items-start gap-2 border-b px-3 py-2 text-xs">
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              RECOMMENDATION_TONE[review.recommendation.kind],
            )}
          >
            推奨: {recommendationLabel(review.recommendation.kind, review.recommendation.text)}
          </span>
          {review.recommendation.reason && (
            <span className="min-w-0 flex-1 text-muted-foreground">{review.recommendation.reason}</span>
          )}
        </div>
      )}

      {hasFindings ? (
        <>
          {review.summary && (
            <div className="border-b px-3 py-2">
              <MarkdownBody
                content={review.summary}
                className="text-xs text-muted-foreground"
                repositoryFullName={repositoryFullName}
              />
            </div>
          )}
          <ol className="divide-y">
            {findings.map((finding) => (
              <FindingItem
                key={finding.number}
                finding={finding}
                skipped={Boolean(skipped[finding.number])}
                reason={reasons[finding.number] ?? ""}
                repositoryFullName={repositoryFullName}
                onChangeSkipped={(value) =>
                  setSkipped((prev) => ({ ...prev, [finding.number]: value }))
                }
                onChangeReason={(value) =>
                  setReasons((prev) => ({ ...prev, [finding.number]: value }))
                }
              />
            ))}
          </ol>
          <footer className="flex flex-col gap-2 border-t bg-muted/50 px-3 py-2 sm:flex-row sm:items-center">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {applyCount === 0
                ? "すべて見送る場合は、この計画のまま承認してください。"
                : `反映 ${applyCount}件・見送り ${skipCount}件${skipCount > 0 ? "。見送る理由も一緒に送ります" : ""}`}
            </p>
            <Button
              size="sm"
              disabled={disabled || isSubmitting || applyCount === 0}
              onClick={submitDecisions}
            >
              {isSubmitting ? <Loader2 className="animate-spin" /> : <ScanSearch />}
              {submitLabel}
            </Button>
          </footer>
        </>
      ) : (
        /* 指摘なし・分けられなかったときは本文を畳んで出す。**指摘なしなら送るボタンは出さない**
           （出し直させる材料が無い。承認は計画承認パネルの主ボタンで行う） */
        <>
          <div className="px-3 py-2">
            <button
              type="button"
              onClick={() => setIsBodyOpen((prev) => !prev)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              aria-expanded={isBodyOpen}
            >
              {isBodyOpen ? (
                <ChevronDown aria-hidden className="size-3" />
              ) : (
                <ChevronRight aria-hidden className="size-3" />
              )}
              レビュー本文
            </button>
            {isBodyOpen && review.body !== "" && (
              <MarkdownBody
                content={review.body}
                className="mt-1 text-xs"
                repositoryFullName={repositoryFullName}
              />
            )}
          </div>
          {!review.noFindings && (
            <footer className="flex flex-col gap-2 border-t bg-muted/50 px-3 py-2 sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                指摘ごとに分けられませんでした。取り込むかどうかの判断はセッションに任せます。
              </p>
              <Button
                size="sm"
                disabled={disabled || isSubmitting}
                onClick={() => void onSubmit(PLAN_REVIEW_REFLECT_REQUEST_TEXT)}
              >
                {isSubmitting ? <Loader2 className="animate-spin" /> : <ScanSearch />}
                {fallbackSubmitLabel}
              </Button>
            </footer>
          )}
        </>
      )}
    </section>
  );
}

const RECOMMENDATION_TONE: Readonly<Record<PlanReviewRecommendationKind, string>> = {
  approve: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  revise: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  redo: "bg-red-500/15 text-red-700 dark:text-red-400",
  other: "bg-muted text-foreground",
};

/** 推奨のチップに出す語。定型句はそのまま、当たらなければ全文を出す（理由は隣に出さない） */
function recommendationLabel(kind: PlanReviewRecommendationKind, text: string): string {
  switch (kind) {
    case "approve":
      return "このまま承認してよい";
    case "revise":
      return "修正のうえ承認";
    case "redo":
      return "計画の作り直し";
    case "other":
      return text;
  }
}

function FindingItem({
  finding,
  skipped,
  reason,
  repositoryFullName,
  onChangeSkipped,
  onChangeReason,
}: {
  finding: PlanReviewFinding;
  skipped: boolean;
  reason: string;
  repositoryFullName?: string;
  onChangeSkipped: (value: boolean) => void;
  onChangeReason: (value: string) => void;
}) {
  const [isEvidenceOpen, setIsEvidenceOpen] = useState(false);
  const reasonId = `plan-review-skip-reason-${finding.number}`;
  // 3項目が1つも読めなかった指摘は、見出しの下の文章をそのまま本文として出す
  const hasFields = finding.problem !== null || finding.proposal !== null || finding.evidence !== null;

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <p
          className={cn(
            "flex min-w-0 flex-1 gap-2 text-sm font-semibold",
            skipped && "text-muted-foreground line-through decoration-border",
          )}
        >
          <span className="shrink-0 font-mono text-xs font-normal tabular-nums text-muted-foreground no-underline">
            {finding.number}
          </span>
          <span className="min-w-0">{finding.title}</span>
        </p>
        <div
          role="group"
          aria-label={`指摘${finding.number}の扱い`}
          className="flex shrink-0 overflow-hidden rounded-md border"
        >
          <button
            type="button"
            aria-pressed={!skipped}
            onClick={() => onChangeSkipped(false)}
            className={cn(
              "h-11 flex-1 px-3 text-xs md:h-7",
              !skipped ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted",
            )}
          >
            反映する
          </button>
          <button
            type="button"
            aria-pressed={skipped}
            onClick={() => onChangeSkipped(true)}
            className={cn(
              "h-11 flex-1 border-l px-3 text-xs md:h-7",
              skipped ? "bg-muted font-semibold text-foreground" : "bg-background text-muted-foreground hover:bg-muted",
            )}
          >
            見送る
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1 pl-5 text-xs">
        {finding.problem && <FindingField label="指摘" content={finding.problem} repositoryFullName={repositoryFullName} />}
        {finding.proposal && <FindingField label="提案" content={finding.proposal} repositoryFullName={repositoryFullName} />}
        {!hasFields && finding.rest && (
          <MarkdownBody content={finding.rest} className="text-xs" repositoryFullName={repositoryFullName} />
        )}
        {finding.evidence && (
          <div>
            <button
              type="button"
              onClick={() => setIsEvidenceOpen((prev) => !prev)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              aria-expanded={isEvidenceOpen}
            >
              {isEvidenceOpen ? (
                <ChevronDown aria-hidden className="size-3" />
              ) : (
                <ChevronRight aria-hidden className="size-3" />
              )}
              根拠
            </button>
            {isEvidenceOpen && (
              <MarkdownBody
                content={finding.evidence}
                className="mt-1 text-xs text-muted-foreground"
                repositoryFullName={repositoryFullName}
              />
            )}
          </div>
        )}
        {skipped && (
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
            <label htmlFor={reasonId} className="shrink-0 text-[11px] text-muted-foreground">
              見送る理由（任意）
            </label>
            <Input
              id={reasonId}
              value={reason}
              maxLength={300}
              onChange={(event) => onChangeReason(event.target.value)}
              placeholder="例: 別のIssueでまとめて直す"
              className="h-9 text-xs md:h-7"
            />
          </div>
        )}
      </div>
    </li>
  );
}

function FindingField({
  label,
  content,
  repositoryFullName,
}: {
  label: string;
  content: string;
  repositoryFullName?: string;
}) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 font-semibold text-muted-foreground">{label}</span>
      <MarkdownBody content={content} className="min-w-0 flex-1 text-xs" repositoryFullName={repositoryFullName} />
    </div>
  );
}
