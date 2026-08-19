"use client";

import { ChevronRight, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { usePullRequestFiles } from "@/hooks/use-pull-request-files";
import {
  PULL_REQUEST_FILE_CHANGE_LABEL,
  splitPullRequestFilePath,
} from "@/lib/pull-request-files";
import { cn } from "@/lib/utils";
import type { PullRequestFile, PullRequestFileChange } from "@/types/pull-request";

type PullRequestFileListProps = {
  /** PRのid（`<owner>/<repo>#<番号>`） */
  pullRequestId: string;
  /** GitHubのPRページのURL。打ち切ったときの誘導先 */
  htmlUrl: string;
  /** 詳細が持つ変更ファイル数。畳んだままでも規模が分かるよう見出しに出す */
  changedFiles: number;
  additions: number;
  deletions: number;
  /** 詳細の取得時刻。ヘッダーの「更新」でこちらも取り直すためのキー */
  refreshKey: string | null;
};

const CHANGE_CLASS: Record<PullRequestFileChange, string> = {
  added: "bg-green-600/15 text-green-700 dark:text-green-400",
  modified: "bg-muted text-muted-foreground",
  removed: "bg-destructive/15 text-destructive",
  renamed: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};

/** 増減の比率を5目盛りで表す（GitHubのFiles changedと同じ見方ができるように） */
function ChangeBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const added = total === 0 ? 0 : Math.max(1, Math.round((additions / total) * 5));
  const removed = total === 0 ? 0 : 5 - added;
  return (
    <span className="hidden shrink-0 gap-px sm:flex" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <span
          key={index}
          className={cn(
            "size-1.5 rounded-[1px]",
            index < added
              ? "bg-green-600 dark:bg-green-500"
              : index < added + removed
                ? "bg-destructive"
                : "bg-border",
          )}
        />
      ))}
    </span>
  );
}

function FileRow({ file }: { file: PullRequestFile }) {
  const { directory, name } = splitPullRequestFilePath(file.path);
  return (
    <li className="flex items-center gap-2 border-t px-4 py-1.5 pl-8 hover:bg-accent/50">
      <span
        className={cn(
          "w-9 shrink-0 rounded py-0.5 text-center text-[10px] font-semibold",
          CHANGE_CLASS[file.change],
        )}
      >
        {PULL_REQUEST_FILE_CHANGE_LABEL[file.change]}
      </span>
      <span
        className="flex min-w-0 flex-1 font-mono text-[11px]"
        title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
      >
        <span className="min-w-0 truncate text-muted-foreground">{directory}</span>
        <span className="shrink-0">{name}</span>
      </span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums">
        <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{" "}
        <span className="text-destructive">-{file.deletions}</span>
      </span>
      <ChangeBar additions={file.additions} deletions={file.deletions} />
      <a
        href={file.blobUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label={`${file.path} をGitHubで開く`}
      >
        <ExternalLink className="size-3" />
      </a>
    </li>
  );
}

/**
 * PR詳細の「変更ファイル」（#1987）。
 *
 * **既定は畳んだ状態で、開いたときだけGitHubからファイル一覧を取りに行く。** 変更ファイルは
 * PRを見るたびに必要なものではない一方、取得には1リクエストかかるため、押した回だけ消費する形に
 * している。畳んでいる間もファイル数と増減は出せる——PR詳細（`/api/pull-requests/detail`）が
 * 既に持っている値で、追加の取得が要らない。
 *
 * 開閉状態はIssue詳細の折りたたみ（`issue-detail-section.tsx`）と同じく**PRごとではなく
 * セクション単位**で覚える。PRごとに覚えると、開くPRが変わるたびに既定へ戻って意味が無い。
 * その結果、**開いたままにしているユーザーはPRを開くたびに1回消費する**（畳んだ状態の人はゼロ）。
 * 「常に消費する」形（詳細APIへの相乗り）と違い、消費するかどうかを畳むかどうかで選べること・
 * 同じPRを開き直すぶんはETagの304で消費しないこと（`fetchPullRequestFiles`）を条件に、
 * 開いた状態の復元でも取得する側へ倒している。
 *
 * 器を`IssueDetailSection`と共有しないのは、**枠の見た目が別物**だから。あちらはIssue詳細の
 * 補助情報を並べる角丸カード（`rounded-lg border`）で、PR詳細のセクションは本文・コメントと
 * 同じ横幅いっぱいの帯（`border-b`）。共有するには`variant`のような分岐を足すことになり、
 * 画面の数だけ枝が増える。開閉の作法（`Collapsible`・セクション単位の保存キー）だけを揃える。
 */
export function PullRequestFileList({
  pullRequestId,
  htmlUrl,
  changedFiles,
  additions,
  deletions,
  refreshKey,
}: PullRequestFileListProps) {
  const [open, setOpen] = usePersistedState("pull-request-detail.section.files", false);
  const { files, truncated, isLoading, error, retry } = usePullRequestFiles(
    pullRequestId,
    open,
    refreshKey,
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 bg-muted/50 px-4 py-2 text-left hover:bg-accent">
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-xs font-semibold">
          変更ファイル
          <span className="ml-1 font-normal text-muted-foreground tabular-nums">
            {changedFiles}
          </span>
        </span>
        <span className="ml-auto shrink-0 text-xs tabular-nums">
          <span className="text-green-600 dark:text-green-400">+{additions}</span>{" "}
          <span className="text-destructive">-{deletions}</span>
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        {error ? (
          <div className="flex flex-col items-start gap-2 border-t px-4 py-3 pl-8">
            <p className="text-xs text-destructive">{error}</p>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={retry}>
              再試行
            </Button>
          </div>
        ) : files === null ? (
          isLoading ? (
            <div className="flex flex-col gap-2 border-t px-4 py-3 pl-8">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ) : null
        ) : files.length === 0 ? (
          <p className="border-t px-4 py-3 pl-8 text-xs text-muted-foreground">
            変更されたファイルはありません。
          </p>
        ) : (
          <>
            <ul>
              {files.map((file) => (
                <FileRow key={file.path} file={file} />
              ))}
            </ul>
            {truncated && (
              <p className="border-t px-4 py-2 pl-8 text-xs text-muted-foreground">
                先頭{files.length}件を表示しています（全{changedFiles}件）。残りは{" "}
                <a
                  href={`${htmlUrl}/files`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  GitHubのFiles changed
                </a>{" "}
                で確認してください。
              </p>
            )}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
