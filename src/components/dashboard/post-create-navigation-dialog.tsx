"use client";

import { FilePlus2, FileText, Undo2, type LucideIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PostCreateDestination } from "@/lib/post-create-destination";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

type PostCreateNavigationDialogProps = {
  /** 作成できたIssue。何を作ったのかを確かめてから選べるよう、番号とタイトルを出す */
  issue: Issue;
  /** タイルを押したとき */
  onSelect: (destination: PostCreateDestination) => void;
  /** ×・Escape・背景クリックで閉じたとき。選ばずに閉じたので、何も起こさない */
  onDismiss: () => void;
};

/**
 * Issueを作った直後に「次に開く画面」を選ぶ一画面（#2862）。
 *
 * 以前は「作成」「作成+実装開始」のどちらを押しても、必ず作ったIssueの詳細へ移動していた。
 * まとめて起票しているときは毎回一覧へ戻る操作が要るため、ここで進む先を選ばせる。
 *
 * **タイルは選択ではなく実行**（押した瞬間に進む）。選んでから決定ボタンを押す形にすると、
 * 今までゼロだった操作が2回に増える。「次回からこの画面を出さない」を入れてから押すと、
 * **この画面からは記憶させない**（#5292）。以前は「次回からこの画面を出さない」チェックで
 * 押した方を既定にできたが、うっかり入れると以降ずっと選択画面が出なくなるため外した。
 * 既定を決めたい人は設定 > 表示から明示的に選ぶ（`usePostCreateDestination`）。
 *
 * 「続けて作成」（#2932）は、**押した瞬間に同じリポジトリの空の作成フォームが開き直る**。
 * まとめて起票するときに、1件ごとに一覧へ戻ってリポジトリを選び直す往復をなくすためのもので、
 * 実行するのは呼び出し元（`create-issue-dialog.tsx`）。
 */
export function PostCreateNavigationDialog({
  issue,
  onSelect,
  onDismiss,
}: PostCreateNavigationDialogProps) {
  const repositoryName = issue.repositoryFullName.split("/")[1] ?? issue.repositoryFullName;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Issueを作成しました</DialogTitle>
          <DialogDescription>次に開く画面を選んでください。</DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2">
          <span className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {repositoryName}
          </span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            #{issue.number}
          </span>
          <span className="truncate text-sm font-medium">{issue.title}</span>
        </div>

        <div role="group" aria-label="次に開く画面" className="grid grid-cols-3 gap-2">
          <DestinationTile
            icon={FileText}
            name="Issueを開く"
            description="作ったIssueの詳細へ"
            onSelect={() => onSelect("detail")}
          />
          <DestinationTile
            icon={FilePlus2}
            name="続けて作成"
            description="同じリポジトリでもう1件"
            onSelect={() => onSelect("another")}
          />
          <DestinationTile
            icon={Undo2}
            name="元の画面に戻る"
            description="開いていた一覧のまま"
            onSelect={() => onSelect("stay")}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 行き先1件（#2862）。**実行先のタイル（`StartImplementationDialog`）と同じ形にそろえる。**
 * 縦に積むアイコン＋名前で、押した瞬間にその画面へ進む。3枚しか並ばないので、
 * 実行先のタイルと違って説明もタイルの中に入る。
 */
function DestinationTile({
  icon: Icon,
  name,
  description,
  onSelect,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-lg border px-2 py-3 text-center",
        "text-foreground hover:bg-accent",
      )}
    >
      <Icon className="size-5 text-muted-foreground" />
      <span className="text-xs leading-tight font-medium">{name}</span>
      <span className="text-[10px] leading-tight text-muted-foreground">{description}</span>
    </button>
  );
}
