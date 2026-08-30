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
  APP_AI_MODEL_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  DISPATCH_CONCURRENCY_MAX,
  DISPATCH_CONCURRENCY_MIN,
  type AppAiModel,
  type ClaudeModel,
  type CodexModel,
} from "@/lib/app-settings";

export type AppSettingsValues = {
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  codexModel: CodexModel;
  appAiModel: AppAiModel;
  dispatchConcurrency: number;
};

type ExecutionSettingsSectionProps = {
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  codexModel: CodexModel;
  appAiModel: AppAiModel;
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
  codexModel: initialCodexModel,
  appAiModel: initialAppAiModel,
  dispatchConcurrency: initialDispatchConcurrency,
  onUpdated,
}: ExecutionSettingsSectionProps) {
  const { updateAutoRetryLimit, updateClaudeModel, updateDispatchConcurrency, isSubmitting, error } =
    useAppSettingsMutations();
  const [autoRetryLimit, setAutoRetryLimit] = useState(initialAutoRetryLimit);
  const [claudeModel, setClaudeModel] = useState<ClaudeModel>(initialClaudeModel);
  const [claudeModelAssist, setClaudeModelAssist] =
    useState<ClaudeModel>(initialClaudeModelAssist);
  const [codexModel, setCodexModel] = useState<CodexModel>(initialCodexModel);
  const [appAiModel, setAppAiModel] = useState<AppAiModel>(initialAppAiModel);
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
    codexModel !== initialCodexModel ||
    appAiModel !== initialAppAiModel ||
    dispatchConcurrency !== initialDispatchConcurrency;

  async function handleSubmit() {
    setIsSaved(false);
    const autoRetryOk = await updateAutoRetryLimit(autoRetryLimit);
    if (!autoRetryOk) return;
    const claudeModelOk = await updateClaudeModel(
      claudeModel,
      claudeModelAssist,
      codexModel,
      appAiModel,
    );
    if (!claudeModelOk) return;
    const dispatchOk = await updateDispatchConcurrency(dispatchConcurrency);
    if (!dispatchOk) return;
    onUpdated({
      autoRetryLimit,
      claudeModel,
      claudeModelAssist,
      codexModel,
      appAiModel,
      dispatchConcurrency,
    });
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
        {/*
          この設定を読むのは`reusable-issue-dispatch.yml`のフォールバック検証ステップだけで、
          ローカルセッション（`scripts/start-issue.sh`）は参照しない。適用先を書かないと
          ローカル実行にも効くと読めてしまうため、対象と例外を明記する（#1808）。
        */}
        <p className="text-xs text-muted-foreground">
          GitHub
          Actionsの無人実行（Issueからの計画・実装）が、計画コメントもPull
          Requestも残せずに終わった場合に、自動で再実行する回数の上限です。0で無効ですが、一過性の障害と判定した場合だけは0でも2回まで再実行します。ローカルセッションには適用されません。全リポジトリ共通の設定です。
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
        <Label htmlFor="codex-model">Codexで使用するモデル</Label>
        <Select value={codexModel} onValueChange={(value) => setCodexModel(value as CodexModel)}>
          <SelectTrigger id="codex-model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODEX_MODEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          サブPCで新しく起動するCodex
          CLIセッションのモデルです。「自動」の場合はモデルを指定せず、Codex
          CLI側のデフォルトモデルが使われます。全リポジトリ共通の設定です。
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="app-ai-model">アプリ内AI機能で使用するモデル</Label>
        <Select value={appAiModel} onValueChange={(value) => setAppAiModel(value as AppAiModel)}>
          <SelectTrigger id="app-ai-model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APP_AI_MODEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Issueの要約・検索・文章整理・手作業の診断など、アプリが直接実行するAI機能で使います。
          高性能なモデルほど応答品質が上がる一方、処理時間とAPI消費量が増える場合があります。
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
          合わせて変えられるよう設定値にしています（既定の3は載せ替え後のCPU実測にもとづく上限で、
          4本にするとメモリが足りずビルドが2倍以上遅くなります）。
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
