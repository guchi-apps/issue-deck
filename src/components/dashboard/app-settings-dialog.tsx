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
import { useAppSettingsMutations } from "@/hooks/use-app-settings-mutations";
import { AUTO_RETRY_LIMIT_MAX, AUTO_RETRY_LIMIT_MIN } from "@/lib/app-settings";

type AppSettingsDialogProps = {
  open: boolean;
  autoRetryLimit: number;
  onOpenChange: (open: boolean) => void;
  onUpdated: (autoRetryLimit: number) => void;
};

export function AppSettingsDialog({
  open,
  autoRetryLimit: initialAutoRetryLimit,
  onOpenChange,
  onUpdated,
}: AppSettingsDialogProps) {
  const { updateAutoRetryLimit, isSubmitting, error, setError } = useAppSettingsMutations();
  const [autoRetryLimit, setAutoRetryLimit] = useState(initialAutoRetryLimit);

  useEffect(() => {
    if (!open) return;
    // ダイアログを開くたびにフォームを現在値へ戻す。外部トリガーへの一度きりの同期。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoRetryLimit(initialAutoRetryLimit);
    setError(null);
  }, [open, initialAutoRetryLimit, setError]);

  async function handleSubmit() {
    const ok = await updateAutoRetryLimit(autoRetryLimit);
    if (ok) {
      onUpdated(autoRetryLimit);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>アプリ設定</DialogTitle>
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
            Codeの実装・計画ワークフローが行き詰まって終了した場合に、自動で再実行する回数の上限です（0で無効）。全リポジトリ共通の設定です。
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
