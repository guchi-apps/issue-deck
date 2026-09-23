import { Loader2 } from "lucide-react";

/**
 * 本文をまだ持っていないIssue（一覧で外されたclosedのIssue。#3390）の、本文欄の代わり。
 * 空の本文と見分けが付くように、読み込み中か失敗かを出す。取得は`useIssueBodies`が行う
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
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      本文を読み込んでいます…
    </p>
  );
}
