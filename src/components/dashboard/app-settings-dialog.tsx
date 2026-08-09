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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppSettingsMutations } from "@/hooks/use-app-settings-mutations";
import {
  AUTO_RETRY_LIMIT_MAX,
  AUTO_RETRY_LIMIT_MIN,
  CLAUDE_MODEL_OPTIONS,
  type ClaudeModel,
} from "@/lib/app-settings";

type AppSettingsDialogProps = {
  open: boolean;
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  onOpenChange: (open: boolean) => void;
  onUpdated: (
    autoRetryLimit: number,
    claudeModel: ClaudeModel,
    claudeModelAssist: ClaudeModel,
  ) => void;
};

export function AppSettingsDialog({
  open,
  autoRetryLimit: initialAutoRetryLimit,
  claudeModel: initialClaudeModel,
  claudeModelAssist: initialClaudeModelAssist,
  onOpenChange,
  onUpdated,
}: AppSettingsDialogProps) {
  const { updateAutoRetryLimit, updateClaudeModel, isSubmitting, error, setError } =
    useAppSettingsMutations();
  const [autoRetryLimit, setAutoRetryLimit] = useState(initialAutoRetryLimit);
  const [claudeModel, setClaudeModel] = useState<ClaudeModel>(initialClaudeModel);
  const [claudeModelAssist, setClaudeModelAssist] =
    useState<ClaudeModel>(initialClaudeModelAssist);

  useEffect(() => {
    if (!open) return;
    // ダイアログを開くたびにフォームを現在値へ戻す。外部トリガーへの一度きりの同期。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoRetryLimit(initialAutoRetryLimit);
    setClaudeModel(initialClaudeModel);
    setClaudeModelAssist(initialClaudeModelAssist);
    setError(null);
  }, [open, initialAutoRetryLimit, initialClaudeModel, initialClaudeModelAssist, setError]);

  async function handleSubmit() {
    const autoRetryOk = await updateAutoRetryLimit(autoRetryLimit);
    if (!autoRetryOk) return;
    const claudeModelOk = await updateClaudeModel(claudeModel, claudeModelAssist);
    if (!claudeModelOk) return;
    onUpdated(autoRetryLimit, claudeModel, claudeModelAssist);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
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

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="claude-model">使用するモデル（実装・計画）</Label>
            <Select value={claudeModel} onValueChange={(value) => setClaudeModel(value as ClaudeModel)}>
              <SelectTrigger id="claude-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLAUDE_MODEL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            計画の立案と実装・PR作成で使用するモデルです。「自動」の場合はモデルを指定せず、Claude
            Code Action側のデフォルトモデルが使われます。全リポジトリ共通の設定です。
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="claude-model-assist">使用するモデル（補助処理）</Label>
            <Select
              value={claudeModelAssist}
              onValueChange={(value) => setClaudeModelAssist(value as ClaudeModel)}
            >
              <SelectTrigger id="claude-model-assist" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLAUDE_MODEL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            質問への回答とサブIssueへの分割で使用するモデルです。実装ほどの精度を必要としないため、
            より軽いモデルを選ぶとコストを抑えられます。
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
