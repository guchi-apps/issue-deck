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
import { useQuickFilterMutations } from "@/hooks/use-quick-filter-mutations";
import { QUICK_FILTER_NAME_MAX_LENGTH } from "@/lib/quick-filters";
import type { QuickFilter, QuickFilterInput } from "@/types/quick-filter";

type QuickFilterDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: Omit<QuickFilterInput, "name">;
  onCreated: (quickFilter: QuickFilter) => void;
};

export function QuickFilterDialog({
  open,
  onOpenChange,
  filters,
  onCreated,
}: QuickFilterDialogProps) {
  const { createQuickFilter, isSubmitting, error, setError } = useQuickFilterMutations();
  const [name, setName] = useState("");

  useEffect(() => {
    if (!open) return;
    // ダイアログを開くたびにフォームを初期状態へ戻す。開閉という外部トリガーに同期する一度きりの処理。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName("");
    setError(null);
  }, [open, setError]);

  async function handleSubmit() {
    if (!name.trim()) return;
    const quickFilter = await createQuickFilter({ ...filters, name: name.trim() });
    if (quickFilter) {
      onCreated(quickFilter);
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>よく使うフィルターとして保存</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-filter-name">名前</Label>
            <Input
              id="quick-filter-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 自分の担当（bugラベル）"
              maxLength={QUICK_FILTER_NAME_MAX_LENGTH}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            現在の検索条件（キーワード・リポジトリ・状態・ラベル・担当者・並び順）を保存します。
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !name.trim()}>
            {isSubmitting ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
