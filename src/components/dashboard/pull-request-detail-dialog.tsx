"use client";

import { X } from "lucide-react";

import { PullRequestDetail } from "@/components/dashboard/pull-request-detail";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type {
  PullRequestSummary,
  PullRequestDetail as PullRequestDetailData,
} from "@/types/pull-request";

type PullRequestDetailDialogProps = {
  /** 開いているPRのid（`<owner>/<repo>#<番号>`）。閉じているときはnull */
  pullRequestId: string | null;
  /** ヘッダーの材料。一覧にも詳細にも無いあいだはnull（読み込み中として描く） */
  pullRequest: PullRequestSummary | null;
  detail: PullRequestDetailData | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onMerged: () => void;
  onClose: () => void;
};

/**
 * 「ユーザーの確認待ち」に並ぶマージ待ちPRを、その場に重ねて開くPR詳細（#2149）。
 *
 * 以前はカードを押すとPR一覧画面（`pane=pull-requests`）へ遷移していた。確認待ちは
 * 「人が動かないと止まるもの」を上から順に片付ける場所なので、1件開くたびに画面ごと移ると
 * 続きを見るのに毎回戻る操作が要る。マージボタンまで含めて同じ`PullRequestDetail`を重ねて
 * 出せば、閉じた時点で一覧がそのまま残る。
 *
 * **開いているかどうかはURLクエリ（`prmodal`）が正**で、`useHistoryDismiss`（#2065の画像
 * プレビュー）のようにstateで持って履歴を自前で積むことはしない。**この重ね表示の中には
 * アプリ内リンク（ヘッダーの「Issue #N」・本文とコメントの参照）があり、押すと現在地の
 * クエリが進む**ため、開閉をstateで持つと下の画面だけが遷移して重ね表示が残る——閉じた先が
 * 押したときの一覧ではなくなり、このIssueで直したい状態そのものになる。クエリなら、リンク側で
 * `prmodal`を落とす（`use-reference-navigation.ts`）だけで「閉じて遷移」になり、戻る操作で
 * 重ね表示ごと戻ってくる。
 *
 * `pr`（PRペイン・スマホのPR詳細画面）とクエリを分ける理由は`use-issue-filters.ts`を参照。
 *
 * 閉じる導線はヘッダー左のバツボタン。`PullRequestDetail`のヘッダー右端は「更新」ボタンが
 * 使っているため、`DialogContent`の既定のバツボタン（右上）とは重なる。
 */
export function PullRequestDetailDialog({
  pullRequestId,
  pullRequest,
  detail,
  isLoading,
  error,
  onRefresh,
  onMerged,
  onClose,
}: PullRequestDetailDialogProps) {
  const open = pullRequestId !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* 中身（PullRequestDetail）が自前でスクロールを持つので、既定の`overflow-y-auto`と
          `gap-4`／`p-4`は打ち消す。高さは画面いっぱいまで伸ばす——本文とコメントが長く、
          小さい枠に収めると確認のたびにスクロールが増える */}
      <DialogContent
        className="h-[calc(100%-2rem)] grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:h-[min(48rem,calc(100%-4rem))] sm:max-w-3xl"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">
          {pullRequest
            ? `${pullRequest.repositoryFullName} #${pullRequest.number} ${pullRequest.title}`
            : "Pull Requestの詳細"}
        </DialogTitle>

        <PullRequestDetail
          pullRequest={pullRequest}
          detail={detail}
          isLoading={isLoading}
          error={error}
          onRefresh={onRefresh}
          onMerged={onMerged}
          className="min-h-0"
          headerLeading={
            <button
              type="button"
              onClick={onClose}
              className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
              aria-label="閉じる"
            >
              <X className="size-4.5" />
            </button>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
