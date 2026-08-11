"use client";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
    (repo) => repo.hasClaudeWorkflow && repo.fullName !== currentRepositoryFullName,
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

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNewRepositoryFullName(destinationCandidates[0]?.fullName ?? "");
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Issueを移動しますか？</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          <p className="text-muted-foreground">
            この操作は取り消せません。移動先リポジトリでIssue番号が新しく振り直され、GitHub上のURLも変わります。移動先に同名のラベルが無い場合、そのラベルは失われます。
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="move-issue-destination">移動先リポジトリ</Label>
            <Select value={newRepositoryFullName} onValueChange={setNewRepositoryFullName}>
              <SelectTrigger id="move-issue-destination" className="w-full">
                <SelectValue placeholder="リポジトリを選択" />
              </SelectTrigger>
              <SelectContent>
                {destinationCandidates.map((repo) => (
                  <SelectItem key={repo.id} value={repo.fullName}>
                    {repo.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
      </DialogContent>
    </Dialog>
  );
}
