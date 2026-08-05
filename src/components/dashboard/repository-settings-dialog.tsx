"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRepositorySettingsMutations } from "@/hooks/use-repository-settings-mutations";
import { AUTO_RETRY_LIMIT_MAX, AUTO_RETRY_LIMIT_MIN } from "@/lib/repository-settings";
import type { ConnectedRepository } from "@/types/repository";

type RepositorySettingsDialogProps = {
  repository: ConnectedRepository | null;
  onOpenChange: (open: boolean) => void;
  onUpdated: (repositoryId: string, autoRetryLimit: number) => void;
};

export function RepositorySettingsDialog({
  repository,
  onOpenChange,
  onUpdated,
}: RepositorySettingsDialogProps) {
  const { updateAutoRetryLimit, isSubmitting, error, setError } =
    useRepositorySettingsMutations();
  const [autoRetryLimit, setAutoRetryLimit] = useState(0);

  useEffect(() => {
    if (!repository) return;
    // ダイアログを開くたびにフォームを対象リポジトリの現在値へ戻す。外部トリガーへの一度きりの同期。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoRetryLimit(repository.autoRetryLimit);
    setError(null);
  }, [repository, setError]);

  async function handleSubmit() {
    if (!repository) return;
    const ok = await updateAutoRetryLimit(repository.id, autoRetryLimit);
    if (ok) {
      onUpdated(repository.id, autoRetryLimit);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={repository !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{repository?.name} の設定</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="auto-retry-limit">自動リトライ回数</Label>
            <Input
              id="auto-retry-limit"
              type="number"
              min={AUTO_RETRY_LIMIT_MIN}
              max={AUTO_RETRY_LIMIT_MAX}
              value={autoRetryLimit}
              onChange={(e) => setAutoRetryLimit(Number(e.target.value))}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Claude
            Codeの実装・計画ワークフローが行き詰まって終了した場合に、自動で再実行する回数の上限です（0で無効）。
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              isSubmitting ||
              autoRetryLimit < AUTO_RETRY_LIMIT_MIN ||
              autoRetryLimit > AUTO_RETRY_LIMIT_MAX ||
              !Number.isInteger(autoRetryLimit)
            }
          >
            {isSubmitting ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
