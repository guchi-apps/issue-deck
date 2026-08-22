"use client";

import { ExternalLink } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { usePullRequestChanges } from "@/hooks/use-pull-request-changes";
import { releaseVersionFromTitle } from "@/lib/branch-flow";
import { pullRequestChangeLabel } from "@/lib/pull-request-changes";
import { cn } from "@/lib/utils";
import type { PullRequestChange, PullRequestSummary } from "@/types/pull-request";

type PullRequestMergeChangesProps = {
  pullRequest: PullRequestSummary;
  /** 確認ダイアログが開いているか。開いているあいだだけ取得する */
  open: boolean;
};

function ChangeRow({ change }: { change: PullRequestChange }) {
  const label = pullRequestChangeLabel(change);
  const bump = change.kind === "version-bump";

  return (
    <li className="flex items-start gap-2 border-b px-3 py-1.5 last:border-b-0">
      {label && (
        <span className="w-11 shrink-0 text-right font-mono text-[11px] leading-6 text-muted-foreground tabular-nums">
          {label}
        </span>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 line-clamp-2 text-xs leading-6",
          bump && "text-muted-foreground",
        )}
      >
        {change.title}
      </span>
      {bump && (
        <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] leading-6 text-muted-foreground">
          バンプ
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
 */
export function PullRequestMergeChanges({ pullRequest, open }: PullRequestMergeChangesProps) {
  const { changes, commitCount, truncated, isLoading, error } = usePullRequestChanges(
    pullRequest.id,
    open,
  );
  const version = releaseVersionFromTitle(pullRequest.title);

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
          <span>番号は対応Issue（特定できないものはPR番号）</span>
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
