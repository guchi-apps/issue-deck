"use client";

import { VerdictText } from "@/components/dashboard/review-verdict";
import { ReleaseRebuildButton } from "@/components/dashboard/release-rebuild-button";
import { useReleaseChanges } from "@/hooks/use-release-changes";
import { useReleaseVerification } from "@/hooks/use-release-verification";
import { RELEASE_BRANCH_PREFIX } from "@/lib/pull-request-list";
import { tallyReleaseReviews } from "@/lib/release-changes";
import type { ReleaseVerificationSection, ReleaseVerificationSummary } from "@/lib/release-verification-summary";
import { cn } from "@/lib/utils";

/**
 * リリース画面の3区分（個別PRレビュー／統合検証／全体レビュー。#4238・#4212）。PC（リリースPR詳細）と
 * スマホ（リリースシート）で共通。**区分ごとに「何を見たか」を分けて出し、どれかの結果を別の区分の
 * 代わりにしない**——AIの全体レビューはテスト実行の代わりにならず、個別PRレビューの転記でもない。
 *
 * 修正は`release-main/*`を直接書き換えず、developへ直してから「修正を入れて作り直す」（#3014）へ進む。
 * 作り直すとSHAが変わるので、新しいSHAで統合検証・全体レビューをやり直す。
 */

const STATE_LABEL: Record<ReleaseVerificationSection["state"], string> = {
  not_run: "未実施",
  waiting: "待機中",
  running: "実行中",
  passed: "問題なし",
  failed: "失敗",
  needs_check: "要確認",
  not_applicable: "対象外",
  invalidated: "古い結果",
};

const STATE_TONE: Record<ReleaseVerificationSection["state"], string> = {
  not_run: "text-muted-foreground",
  waiting: "text-muted-foreground",
  running: "text-blue-700 dark:text-blue-400",
  passed: "text-green-700 dark:text-green-400",
  failed: "text-destructive",
  needs_check: "text-amber-700 dark:text-amber-400",
  not_applicable: "text-muted-foreground",
  invalidated: "text-amber-700 dark:text-amber-400",
};

const GATE_LABEL: Record<ReleaseVerificationSummary["gateStatus"], string> = {
  ready: "検証は揃っています（準備完了）",
  needs_confirmation: "要確認があります。理由を読んで、問題なければ明示して進めます",
  blocked: "未完了または失敗があるため、まだ進められません",
  not_enforced: "",
};

function StateText({ state }: { state: ReleaseVerificationSection["state"] }) {
  return <span className={cn("font-medium", STATE_TONE[state])}>{STATE_LABEL[state]}</span>;
}

function SectionShell({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1 rounded-md border px-3 py-2 text-xs" data-testid={`release-section-${title}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        {note && <span className="text-[10px] text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function IndividualReviewSection({
  repositoryFullName,
  pullRequestNumber,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
}) {
  const { data, isLoading, error } = useReleaseChanges(repositoryFullName, true, pullRequestNumber);
  const tally = data ? tallyReleaseReviews(data.pullRequests) : null;
  return (
    <SectionShell title="個別PRレビュー" note="develop向けPRごとの自動レビュー">
      {error && <p className="text-destructive">{error}</p>}
      {!error && isLoading && !tally && <p className="text-muted-foreground">取得中です…</p>}
      {tally && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span>
            <span className="font-semibold tabular-nums">{tally.total}</span>
            <span className="text-muted-foreground"> 件</span>
          </span>
          <VerdictText kind="ok" label="問題なし" count={tally.ok} />
          <VerdictText kind="needs-check" label="要確認" count={tally.needsCheck} />
          <VerdictText kind="changes-requested" label="要修正" count={tally.changesRequested} />
          <VerdictText kind="skipped" label="レビューなし" count={tally.skipped} />
          <VerdictText kind="unknown" label="記録なし" count={tally.unknown} />
          {tally.unavailable > 0 && <span className="text-destructive">取得不可 {tally.unavailable}件</span>}
        </div>
      )}
    </SectionShell>
  );
}

function IntegrationSection({ section }: { section: ReleaseVerificationSection }) {
  return (
    <SectionShell title="統合検証" note="mainへ統合した状態のビルド・テスト">
      <p>
        <StateText state={section.state} />
        {section.reason && <span className="ml-2 text-muted-foreground">{section.reason}</span>}
      </p>
      {section.summary && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">実施内容</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
            {section.summary}
          </pre>
        </details>
      )}
      {section.evidenceUrl && (
        <a href={section.evidenceUrl} target="_blank" rel="noreferrer" className="w-fit underline">
          既存CIの記録
        </a>
      )}
    </SectionShell>
  );
}

const SEVERITY_LABEL = { high: "重大", medium: "中", low: "軽微" } as const;

function AiReviewSection({
  section,
  assignee,
  repositoryFullName,
}: {
  section: ReleaseVerificationSection;
  assignee: string;
  repositoryFullName: string;
}) {
  const needsFix =
    section.findings.length > 0 || section.state === "failed" || section.state === "invalidated";
  return (
    <SectionShell title="全体レビュー" note="リリース差分全体のAIレビュー">
      <p>
        <StateText state={section.state} />
        <span className="ml-2 text-muted-foreground">担当: {section.agent ?? assignee}</span>
      </p>
      {section.reason && <p className="text-muted-foreground">{section.reason}</p>}
      {section.totalFiles !== null && section.reviewedFiles !== null && (
        <p className="text-muted-foreground">
          確認した範囲: {section.reviewedFiles} / {section.totalFiles} ファイル
        </p>
      )}
      {section.summary && <p className="whitespace-pre-wrap">{section.summary}</p>}
      {section.findings.length > 0 && (
        <ul className="flex flex-col gap-1">
          {section.findings.map((finding, index) => (
            <li key={`${finding.title}-${index}`} className="rounded bg-muted/40 px-2 py-1">
              <span className={finding.severity === "high" ? "font-medium text-destructive" : "font-medium"}>
                [{SEVERITY_LABEL[finding.severity] ?? "中"}] {finding.title}
              </span>
              {finding.file && <span className="ml-2 text-muted-foreground">{finding.file}</span>}
              {finding.detail && <p className="whitespace-pre-wrap text-muted-foreground">{finding.detail}</p>}
              {finding.pullRequests?.length > 0 && (
                <p className="text-muted-foreground">影響PR: {finding.pullRequests.map((n) => `#${n}`).join(" ")}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {section.affectedFiles.length > 0 && (
        <p className="break-all text-muted-foreground">影響ファイル: {section.affectedFiles.slice(0, 20).join(", ")}</p>
      )}
      <p className="text-[10px] text-muted-foreground">
        AIが問題なしと判断しても、自動で本番へマージはしません。マージは人が行います。
      </p>
      {needsFix && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-1.5 text-muted-foreground">
          <span>
            修正はリリースブランチを直接直さず、developへ入れてから作り直します。作り直すとSHAが変わり、統合検証と全体レビューがやり直されます。
          </span>
          <ReleaseRebuildButton repositoryFullName={repositoryFullName} />
        </div>
      )}
    </SectionShell>
  );
}

export function ReleaseReviewSections({
  repositoryFullName,
  pullRequestNumber,
  headRef,
  verification,
  className,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  /** 凍結ブランチ（`release-main/…`）のリリースPRにだけ出す。旧世代（head=develop）は検証の対象外 */
  headRef: string;
  verification: ReleaseVerificationSummary | null;
  className?: string;
}) {
  if (!headRef.startsWith(RELEASE_BRANCH_PREFIX)) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="release-review-sections">
      <IndividualReviewSection repositoryFullName={repositoryFullName} pullRequestNumber={pullRequestNumber} />
      {verification ? (
        <>
          <IntegrationSection section={verification.integration} />
          <AiReviewSection
            section={verification.aiReview}
            assignee={verification.aiReviewAssignee}
            repositoryFullName={repositoryFullName}
          />
          <p className="text-[11px] text-muted-foreground">
            {verification.enforced
              ? GATE_LABEL[verification.gateStatus]
              : "この3区分は現在、表示のみです（このリポジトリでは検証結果をマージの条件にしていません）。"}
          </p>
          {verification.enforced && verification.blockers.length > 0 && (
            <ul className="list-disc pl-5 text-[11px] text-muted-foreground">
              {verification.blockers.map((blocker) => (
                <li key={`${blocker.kind}-${blocker.state}`}>{blocker.reason}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground">統合検証・全体レビューの状態を取得できませんでした。</p>
      )}
    </div>
  );
}

/** PCのリリースPR詳細用。状態は自分で取得する（スマホのシートは`GET /api/repositories/release`の応答を渡す） */
export function ConnectedReleaseReviewSections({
  repositoryFullName,
  pullRequestNumber,
  headRef,
  className,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  headRef: string;
  className?: string;
}) {
  const { verification, error } = useReleaseVerification(
    repositoryFullName,
    pullRequestNumber,
    headRef.startsWith(RELEASE_BRANCH_PREFIX),
  );
  return (
    <>
      <ReleaseReviewSections
        repositoryFullName={repositoryFullName}
        pullRequestNumber={pullRequestNumber}
        headRef={headRef}
        verification={verification}
        className={className}
      />
      {error && <p className="px-4 text-[11px] text-destructive">{error}</p>}
    </>
  );
}
