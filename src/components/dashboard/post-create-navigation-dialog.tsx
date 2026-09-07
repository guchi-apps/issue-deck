"use client";

import { useState } from "react";
import { FileText, Undo2, type LucideIcon } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
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
  /** タイルを押したとき。`remember`は「次回からこの画面を出さない」が入っているか */
  onSelect: (destination: PostCreateDestination, remember: boolean) => void;
  /** ×・Escape・背景クリックで閉じたとき。選ばずに閉じたので、記憶もせず何も起こさない */
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
 * その押した方が端末ごとの既定として残る（`usePostCreateDestination`）。
 *
 * **閉じただけのときは何も記憶しない。** ×・Escapeは「まだ決めていない」であって、
 * 「元の画面に戻るを既定にする」ではない。
 */
export function PostCreateNavigationDialog({
  issue,
  onSelect,
  onDismiss,
}: PostCreateNavigationDialogProps) {
  const [remember, setRemember] = useState(false);
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

        <div role="group" aria-label="次に開く画面" className="grid grid-cols-2 gap-2">
          <DestinationTile
            icon={FileText}
            name="Issueを開く"
            description="作ったIssueの詳細へ"
            onSelect={() => onSelect("detail", remember)}
          />
          <DestinationTile
            icon={Undo2}
            name="元の画面に戻る"
            description="開いていた一覧のまま"
            onSelect={() => onSelect("stay", remember)}
          />
        </div>

        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={remember}
            onCheckedChange={(checked) => setRemember(checked === true)}
            className="mt-0.5 shrink-0"
          />
          <span>
            次回からこの画面を出さず、いま押した方へ進む
            <span className="block text-[11px]">設定 &gt; 表示 で、いつでも選び直せます。</span>
          </span>
        </label>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 行き先1件（#2862）。**実行先のタイル（`StartImplementationDialog`）と同じ形にそろえる。**
 * 縦に積むアイコン＋名前で、押した瞬間にその画面へ進む。2枚しか並ばないので、
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
