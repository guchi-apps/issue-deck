"use client";

import { ExternalLink } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import type { UsePullRequestChangesResult } from "@/hooks/use-pull-request-changes";
import { pullRequestChangeIssueLabel, pullRequestChangeLabel } from "@/lib/pull-request-changes";
import type { PullRequestChange, PullRequestSummary } from "@/types/pull-request";

/**
 * 一覧に出すのは実際に入る変更だけ。**バージョンバンプのPRは外す**（#3260）。
 *
 * リリースには前の版のバンプPR（`v1.0.12をリリースする`）が必ず含まれ、毎回同じ行が並んでいた。
 * 何が上がるかは上の「バージョン」（`PullRequestMergeVersion`）が示すので、行としては要らない。
 * PR件数にも数えない（数えると、見えている行数と件数がずれる）。
 */
function withoutVersionBumps(changes: PullRequestChange[]): PullRequestChange[] {
  return changes.filter((change) => change.kind !== "version-bump");
}

type PullRequestMergeChangesProps = {
  pullRequest: PullRequestSummary;
  /** 変更点の取得結果。取得は親（`PullRequestMergeProduction`）が1回だけ行い、「マージ前の確認」と共有する */
  state: UsePullRequestChangesResult;
};

function ChangeRow({ change }: { change: PullRequestChange }) {
  const label = pullRequestChangeLabel(change);
  const issueLabel = pullRequestChangeIssueLabel(change);

  return (
    <li className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
      {label && (
        <span className="w-11 shrink-0 text-right font-mono text-[11px] leading-6 text-primary tabular-nums">
          {label}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-xs leading-6">{change.title}</span>
      {/* 対応Issue番号は主語ではなくなったが、Issueから探す読み方も残す。幅が足りない画面では畳む */}
      {issueLabel && (
        <span className="hidden shrink-0 font-mono text-[11px] leading-6 text-muted-foreground tabular-nums sm:inline">
          {issueLabel}
        </span>
      )}
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
 * **行の主語はPull Request。ここには「何が入るか」だけを出し、レビュー判定は出さない**（#3093）。
 * 各行に判定を並べていた（#2843）が、判定は「マージ前の確認」のレビュー行へ集約した
 * （`PullRequestMergePrecheck`）。一覧は何のPRが含まれるかを読む場所にとどめる。
 */
export function PullRequestMergeChanges({ pullRequest, state }: PullRequestMergeChangesProps) {
  const { changes: allChanges, commitCount, truncated, isLoading, error } = state;
  const changes = allChanges === null ? null : withoutVersionBumps(allChanges);

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
        <span className="text-xs font-semibold">このリリースに含まれる変更</span>
        {changes !== null && (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
            PR {changes.length}件 ・ コミット{" "}
            {truncated ? `${commitCount}件以上` : `${commitCount}件`}
          </span>
        )}
      </div>

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
          このマージに含まれる変更はありません。
        </p>
      )}

      {changes !== null && changes.length > 0 && (
        <ul className="max-h-[min(13.5rem,40vh)] overflow-y-auto">
          {changes.map((change) => (
            <ChangeRow key={change.id} change={change} />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        {truncated ? (
          <span>コミットが多いため一部だけを出しています</span>
        ) : (
          <span>番号はPull Request</span>
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
