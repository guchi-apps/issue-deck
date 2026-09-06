"use client";

import { ExternalLink } from "lucide-react";

import { VerdictText } from "@/components/dashboard/review-verdict";
import { Skeleton } from "@/components/ui/skeleton";
import { usePullRequestChanges } from "@/hooks/use-pull-request-changes";
import { releaseVersionFromTitle } from "@/lib/branch-flow";
import {
  applyReviewVerdicts,
  pullRequestChangeIssueLabel,
  pullRequestChangeLabel,
  tallyChangeReviews,
  type PullRequestChangeReview,
} from "@/lib/pull-request-changes";
import { cn } from "@/lib/utils";
import type { PullRequestSummary } from "@/types/pull-request";

type PullRequestMergeChangesProps = {
  pullRequest: PullRequestSummary;
  /** 確認ダイアログが開いているか。開いているあいだだけ取得する */
  open: boolean;
};

function ChangeRow({ change }: { change: PullRequestChangeReview }) {
  const label = pullRequestChangeLabel(change);
  const issueLabel = pullRequestChangeIssueLabel(change);
  const bump = change.kind === "version-bump";

  return (
    <li className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
      {label && (
        <span className="w-11 shrink-0 text-right font-mono text-[11px] leading-6 text-primary tabular-nums">
          {label}
        </span>
      )}
      <span className={cn("min-w-0 flex-1 truncate text-xs leading-6", bump && "text-muted-foreground")}>
        {change.title}
      </span>
      {bump && (
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] leading-6 text-muted-foreground">
          バンプ
        </span>
      )}
      {/* 対応Issue番号は主語ではなくなったが、Issueから探す読み方も残す。幅が足りない
          画面では畳む（判定より先に落とすものはここしかない） */}
      {issueLabel && (
        <span className="hidden shrink-0 font-mono text-[11px] leading-6 text-muted-foreground tabular-nums sm:inline">
          {issueLabel}
        </span>
      )}
      <VerdictText
        kind={change.reviewKind}
        label={change.reviewLabel}
        className="w-[5.25rem] shrink-0 text-[11px]"
      />
    </li>
  );
}

/**
 * マージ確認ダイアログに出す「このリリースに含まれる変更」（#2080）。
 *
 * **mainへのPRでしか出さない**（呼び出し側の`isProductionMerge`で分岐する）。押した瞬間に
 * 本番デプロイが走るマージなのに、ダイアログにはPR番号とブランチ名しか出ておらず、何を本番へ
 * 出そうとしているのかがその場では分からなかった——確かめるにはGitHubのPRを開くしかなく、
 * スマホの通知から辿り着いた場面ではそこで判断が止まっていた。
 *
 * 並べるのは**developへ入ったPRとその対応Issue**（`toPullRequestChanges`）。PR本文の
 * 「## 対象issue」は使わない——あれはPRを作った時点の一覧で、PRが開いているあいだにdevelopへ
 * 入った変更が抜けるため、コミットから毎回組み立て直す。
 *
 * **取得できなくてもマージは止めない。** 変更点は判断材料であって、マージの前提条件ではない。
 * 取得中は骨組みだけを出し、失敗したときは理由とGitHubへの導線を出す。
 *
 * **行の主語はPull Requestで、各行にそのPRの自動レビュー判定を出す**（#2843）。コードレビューが
 * 走る単位はPRで、判定もPRに紐づくため、行頭がIssue番号のままだと「この判定はどのPRのものか」を
 * 読み替えることになっていた。判定はリリースPR本文の検証結果の表にPR番号つきで残っており
 * （`pullRequest.releaseVerification`）、番号で突き合わせるだけなのでGitHub APIの消費は増えない。
 * 見出しの下の帯は、行を1つずつ読む前に「何本のうち何本が要修正か」を出すためのもの。
 */
export function PullRequestMergeChanges({ pullRequest, open }: PullRequestMergeChangesProps) {
  const { changes, commitCount, truncated, isLoading, error } = usePullRequestChanges(
    pullRequest.id,
    open,
  );
  const version = releaseVersionFromTitle(pullRequest.title);
  // 判定はリリースPRの本文に載っていて、一覧の取得時点で読み終わっている（#2843）。
  // 変更点の取得を待つのは一覧の行だけで、判定の突き合わせは行が揃った時点で済む。
  const reviewed = changes === null ? null : applyReviewVerdicts(changes, pullRequest.releaseVerification);
  const tally = reviewed === null ? null : tallyChangeReviews(reviewed);
  // 判定が1件も取れていないリリース（自動レビューを持たないリポジトリ）では内訳の帯を出さない
  // ——「記録なし 5件」だけの帯になるため。1件でも判定があれば「記録なし」も並べて、
  // 行数と分母が合わない理由を読めるようにする（母数からバンプPRは外れている）
  const hasVerdicts = tally !== null && tally.total > tally.unknown;

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
        <span className="text-xs font-semibold">このリリースに含まれる変更</span>
        {version && (
          <span className="shrink-0 rounded-full border px-2 font-mono text-[11px] leading-5">
            v{version}
          </span>
        )}
        {changes !== null && (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
            PR {changes.length}件 ・ コミット{" "}
            {truncated ? `${commitCount}件以上` : `${commitCount}件`}
          </span>
        )}
      </div>

      {/* 「5本のうち1本が要修正」を、行を1つずつ読む前に出す（#2843） */}
      {hasVerdicts && tally && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-1.5 text-[11px]">
          <VerdictText kind="ok" label="問題なし" count={tally.ok} />
          <VerdictText kind="needs-check" label="要確認" count={tally.needsCheck} />
          <VerdictText kind="changes-requested" label="要修正" count={tally.changesRequested} />
          <VerdictText kind="skipped" label="レビューなし" count={tally.skipped} />
          <VerdictText kind="unknown" label="記録なし" count={tally.unknown} />
        </div>
      )}

      {isLoading && (
        <div className="space-y-2 px-3 py-2.5">
          <Skeleton className="h-2.5 w-3/4" />
          <Skeleton className="h-2.5 w-3/5" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      )}

      {error && (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">変更点を取得できませんでした。</span>{" "}
          {error}
        </p>
      )}

      {changes !== null && changes.length === 0 && (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          このマージに含まれるコミットはありません。
        </p>
      )}

      {reviewed !== null && reviewed.length > 0 && (
        <ul className="max-h-[min(13.5rem,40vh)] overflow-y-auto">
          {reviewed.map((change) => (
            <ChangeRow key={change.id} change={change} />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        {truncated ? (
          <span>コミットが多いため一部だけを出しています</span>
        ) : (
          <span>番号はPull Request。判定は自動レビューの結果</span>
        )}
        <a
          href={`${pullRequest.htmlUrl}/files`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex shrink-0 items-center gap-1 text-foreground hover:underline"
        >
          GitHubで差分を見る
          <ExternalLink aria-hidden className="size-3" />
        </a>
      </div>
    </div>
  );
}
