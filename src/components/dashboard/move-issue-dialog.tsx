"use client";

import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiErrorMessage } from "@/components/dashboard/api-error-message";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type MoveIssueDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issue: Issue;
  repositories: ConnectedRepository[];
  onMoved: (issue: Issue) => void;
};

/**
 * 移動先として選べるリポジトリを返す。移動元リポジトリ自身に加えて、
 * claude-issue-dispatch.yml未導入（IssueDeckの自動化に未対応）のリポジトリも除く（#1074）。
 * 未対応リポジトリへ移すとラベル運用も自動実行も引き継げず、移動が取り消せないため。
 */
export function moveDestinationRepositories(
  repositories: ConnectedRepository[],
  currentRepositoryFullName: string,
): ConnectedRepository[] {
  return repositories.filter(
    (repo) => repo.fullName !== currentRepositoryFullName,
  );
}

export function MoveIssueDialog({
  open,
  onOpenChange,
  issue,
  repositories,
  onMoved,
}: MoveIssueDialogProps) {
  const { transferIssue, isSubmitting, error, setError } = useIssueMutations();
  const destinationCandidates = moveDestinationRepositories(repositories, issue.repositoryFullName);
  const [newRepositoryFullName, setNewRepositoryFullName] = useState<string>("");
  const [view, setView] = useState<"main" | "pick">("main");

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNewRepositoryFullName(destinationCandidates[0]?.fullName ?? "");
    setView("main");
    setError(null);
    // destinationCandidatesはrepositories/issueから毎レンダー新しい配列参照になるため、
    // 依存配列には含めずopen変化時のみ初期化する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setError]);

  async function handleConfirm() {
    if (!newRepositoryFullName) return;
    const moved = await transferIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      newRepositoryFullName,
    });
    if (moved) {
      onOpenChange(false);
      onMoved(moved);
    }
  }

  const selectedLabel = newRepositoryFullName || "リポジトリを選択";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-h-[26rem] overflow-hidden">
        {/* 選択画面（右からスライド）が開いている間、元の画面は少し左へ寄ってフェードする（#5275） */}
        <div
          className={cn(
            "flex flex-col gap-4 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none",
            view === "pick" && "-translate-x-[28%] opacity-60",
          )}
          inert={view === "pick"}
        >
          <DialogHeader>
            <DialogTitle>Issueを移動しますか？</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 text-sm">
            <p className="text-muted-foreground">
              この操作は取り消せません。移動先リポジトリでIssue番号が新しく振り直され、GitHub上のURLも変わります。移動先に同名のラベルが無い場合、そのラベルは失われます。
            </p>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="move-issue-destination">移動先リポジトリ</Label>
              <button
                id="move-issue-destination"
                type="button"
                onClick={() => setView("pick")}
                className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <span className={newRepositoryFullName ? "" : "text-muted-foreground"}>
                  {selectedLabel}
                </span>
                <ChevronRightIcon className="size-4 text-muted-foreground" />
              </button>
              <p className="text-xs text-muted-foreground">
                IssueDeckの自動化に対応済み（claude-issue-dispatch.yml導入済み）のリポジトリのみ表示しています。
              </p>
            </div>

            <ApiErrorMessage message={error} />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              disabled={isSubmitting || !newRepositoryFullName}
            >
              {isSubmitting ? "移動中..." : "移動する"}
            </Button>
          </DialogFooter>
        </div>

        <div
          className={cn(
            "absolute inset-0 flex flex-col bg-background transition-transform duration-300 ease-out motion-reduce:transition-none",
            view === "pick" ? "translate-x-0" : "translate-x-full",
          )}
          inert={view !== "pick"}
          aria-hidden={view !== "pick"}
        >
          <div className="flex items-center gap-3 border-b px-4 py-3 pr-12">
            <button
              type="button"
              onClick={() => setView("main")}
              className="flex items-center text-sm font-medium text-primary"
            >
              <ChevronLeftIcon className="size-4" />
              戻る
            </button>
            <span className="text-sm font-semibold">移動先リポジトリ</span>
          </div>
          <div className="flex-1 overflow-y-auto" role="listbox" aria-label="移動先リポジトリ">
            {destinationCandidates.map((repo) => (
              <button
                key={repo.id}
                type="button"
                role="option"
                aria-selected={repo.fullName === newRepositoryFullName}
                onClick={() => {
                  setNewRepositoryFullName(repo.fullName);
                  setView("main");
                }}
                className="flex w-full items-center justify-between border-b px-4 py-3 text-left text-sm hover:bg-accent"
              >
                <span>{repo.fullName}</span>
                {repo.fullName === newRepositoryFullName && <CheckIcon className="size-4" />}
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
