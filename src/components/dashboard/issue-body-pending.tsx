import { Skeleton } from "@/components/ui/skeleton";

/**
 * 本文をまだ持っていないIssue（一覧で外されたclosedのIssue。#3390）の、本文欄の代わり。
 * 空の本文と見分けが付くように、読み込み中か失敗かを出す。取得は`useIssueBodies`が行う。
 * 読み込み中は本文の行を模したスケルトンにして、取得後の位置の跳ねを抑える（#5408）
 */
export function IssueBodyPending({ failed }: { failed: boolean }) {
  if (failed) {
    return (
      <p className="text-sm text-muted-foreground">
        本文を読み込めませんでした。別のIssueを開いてから戻ると、もう一度読み込みます。
      </p>
    );
  }
  return (
    <div role="status" aria-busy="true" aria-label="本文を読み込んでいます" className="flex flex-col gap-2.5">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}
