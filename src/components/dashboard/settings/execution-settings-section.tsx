"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
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
  DISPATCH_CONCURRENCY_MAX,
  DISPATCH_CONCURRENCY_MIN,
  type ClaudeModel,
} from "@/lib/app-settings";

export type AppSettingsValues = {
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  dispatchConcurrency: number;
};

type ExecutionSettingsSectionProps = {
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  dispatchConcurrency: number;
  // 設定項目が増えるたびに引数の順番を覚え直すことになるため、まとめて1つの値で渡す
  onUpdated: (values: AppSettingsValues) => void;
};

/**
 * 設定の「実行設定」区分（#1539）。**保存を押すまで効かない値だけ**を置く。
 *
 * 以前は同じダイアログに即時実行のセクション（共有ワークフローのバージョン・
 * シークレット同期）が同居し、フッターの「保存」がどこまで効くのか分からなかった。
 * 保存ボタンを持つのはこの区分だけ、という切り分けを保つこと。
 */
export function ExecutionSettingsSection({
  autoRetryLimit: initialAutoRetryLimit,
  claudeModel: initialClaudeModel,
  claudeModelAssist: initialClaudeModelAssist,
  dispatchConcurrency: initialDispatchConcurrency,
  onUpdated,
}: ExecutionSettingsSectionProps) {
  const { updateAutoRetryLimit, updateClaudeModel, updateDispatchConcurrency, isSubmitting, error } =
    useAppSettingsMutations();
  const [autoRetryLimit, setAutoRetryLimit] = useState(initialAutoRetryLimit);
  const [claudeModel, setClaudeModel] = useState<ClaudeModel>(initialClaudeModel);
  const [claudeModelAssist, setClaudeModelAssist] =
    useState<ClaudeModel>(initialClaudeModelAssist);
  const [dispatchConcurrency, setDispatchConcurrency] = useState(initialDispatchConcurrency);
  const [isSaved, setIsSaved] = useState(false);

  // フォームの初期化はマウント時のuseStateだけで済ませ、effectでの再同期は持たない。
  // このセクションは区分を切り替えるたび・設定を閉じるたびにアンマウントされるため、
  // 開き直せば必ず現在値から始まる。保存後に親から新しい値が降りてくる経路と
  // 競合しないぶん、「保存しました」の表示もそのまま残せる。

  const isValid =
    Number.isInteger(autoRetryLimit) &&
    autoRetryLimit >= AUTO_RETRY_LIMIT_MIN &&
    autoRetryLimit <= AUTO_RETRY_LIMIT_MAX &&
    Number.isInteger(dispatchConcurrency) &&
    dispatchConcurrency >= DISPATCH_CONCURRENCY_MIN &&
    dispatchConcurrency <= DISPATCH_CONCURRENCY_MAX;

  const isDirty =
    autoRetryLimit !== initialAutoRetryLimit ||
    claudeModel !== initialClaudeModel ||
    claudeModelAssist !== initialClaudeModelAssist ||
    dispatchConcurrency !== initialDispatchConcurrency;

  async function handleSubmit() {
    setIsSaved(false);
    const autoRetryOk = await updateAutoRetryLimit(autoRetryLimit);
    if (!autoRetryOk) return;
    const claudeModelOk = await updateClaudeModel(claudeModel, claudeModelAssist);
    if (!claudeModelOk) return;
    const dispatchOk = await updateDispatchConcurrency(dispatchConcurrency);
    if (!dispatchOk) return;
    onUpdated({ autoRetryLimit, claudeModel, claudeModelAssist, dispatchConcurrency });
    setIsSaved(true);
  }

  return (
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
        <p className="text-xs text-muted-foreground">
          Claude
          Codeの実装・計画ワークフローが行き詰まって終了した場合に、自動で再実行する回数の上限です（0で無効）。全リポジトリ共通の設定です。
        </p>
      </div>

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
        <p className="text-xs text-muted-foreground">
          計画の立案と実装・PR作成で使用するモデルです。「自動」の場合はモデルを指定せず、Claude
          Code Action側のデフォルトモデルが使われます。全リポジトリ共通の設定です。
        </p>
      </div>

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
        <p className="text-xs text-muted-foreground">
          質問への回答とサブIssueへの分割で使用するモデルです。実装ほどの精度を必要としないため、
          より軽いモデルを選ぶとコストを抑えられます。
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="dispatch-concurrency">サブPCの同時実行数</Label>
        <Input
          id="dispatch-concurrency"
          type="number"
          min={DISPATCH_CONCURRENCY_MIN}
          max={DISPATCH_CONCURRENCY_MAX}
          value={dispatchConcurrency}
          onChange={(e) => setDispatchConcurrency(Number(e.target.value))}
        />
        <p className="text-xs text-muted-foreground">
          サブPCへディスパッチしたジョブを同時に何本まで走らせるかの上限です。CPUの実力に
          合わせて変えられるよう設定値にしています（既定の2は現在のCPUでの実測値）。
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-3 border-t pt-4">
        <Button onClick={handleSubmit} disabled={isSubmitting || !isValid || !isDirty}>
          {isSubmitting ? "保存中..." : "保存"}
        </Button>
        {isSaved && !isDirty && (
          <span className="text-xs text-muted-foreground">保存しました</span>
        )}
        {isDirty && !isSubmitting && (
          <span className="text-xs text-muted-foreground">未保存の変更があります</span>
        )}
      </div>
    </div>
  );
}
