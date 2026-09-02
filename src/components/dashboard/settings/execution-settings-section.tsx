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
  CLAUDE_LOCAL_MODEL_OPTIONS,
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
  claudeLocalModel: ClaudeModel;
  codexModel: CodexModel;
  appAiModel: AppAiModel;
  appAiModelReasoning: AppAiModel;
  dispatchConcurrency: number;
};

type ExecutionSettingsSectionProps = {
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  claudeLocalModel: ClaudeModel;
  codexModel: CodexModel;
  appAiModel: AppAiModel;
  appAiModelReasoning: AppAiModel;
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
  claudeLocalModel: initialClaudeLocalModel,
  codexModel: initialCodexModel,
  appAiModel: initialAppAiModel,
  appAiModelReasoning: initialAppAiModelReasoning,
  dispatchConcurrency: initialDispatchConcurrency,
  onUpdated,
}: ExecutionSettingsSectionProps) {
  const { updateAutoRetryLimit, updateClaudeModel, updateDispatchConcurrency, isSubmitting, error } =
    useAppSettingsMutations();
  const [autoRetryLimit, setAutoRetryLimit] = useState(initialAutoRetryLimit);
  const [claudeModel, setClaudeModel] = useState<ClaudeModel>(initialClaudeModel);
  const [claudeModelAssist, setClaudeModelAssist] =
    useState<ClaudeModel>(initialClaudeModelAssist);
  const [claudeLocalModel, setClaudeLocalModel] =
    useState<ClaudeModel>(initialClaudeLocalModel);
  const [codexModel, setCodexModel] = useState<CodexModel>(initialCodexModel);
  const [appAiModel, setAppAiModel] = useState<AppAiModel>(initialAppAiModel);
  const [appAiModelReasoning, setAppAiModelReasoning] =
    useState<AppAiModel>(initialAppAiModelReasoning);
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
    claudeLocalModel !== initialClaudeLocalModel ||
    codexModel !== initialCodexModel ||
    appAiModel !== initialAppAiModel ||
    appAiModelReasoning !== initialAppAiModelReasoning ||
    dispatchConcurrency !== initialDispatchConcurrency;

  async function handleSubmit() {
    setIsSaved(false);
    const autoRetryOk = await updateAutoRetryLimit(autoRetryLimit);
    if (!autoRetryOk) return;
    const claudeModelOk = await updateClaudeModel(
      claudeModel,
      claudeModelAssist,
      claudeLocalModel,
      codexModel,
      appAiModel,
      appAiModelReasoning,
    );
    if (!claudeModelOk) return;
    const dispatchOk = await updateDispatchConcurrency(dispatchConcurrency);
    if (!dispatchOk) return;
    onUpdated({
      autoRetryLimit,
      claudeModel,
      claudeModelAssist,
      claudeLocalModel,
      codexModel,
      appAiModel,
      appAiModelReasoning,
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
        <Label htmlFor="claude-model">GitHub Actions（Claude）：計画・実装・レビュー</Label>
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
          GitHub Actionsで計画を作り、計画をレビューし、実装してPRを作る処理に使います。
          通常はSonnet、難しい設計を優先する場合はOpusが適しています。全リポジトリ共通です。
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="claude-model-assist">GitHub Actions（Claude）：質問回答・Issue分割</Label>
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
          GitHub Actionsで質問へ回答し、大きなIssueを分割する処理に使います。通常はHaikuで十分です。
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="claude-local-model">サブPC（Claude）：計画・実装</Label>
        <Select
          value={claudeLocalModel}
          onValueChange={(value) => setClaudeLocalModel(value as ClaudeModel)}
        >
          <SelectTrigger id="claude-local-model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLAUDE_LOCAL_MODEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          サブPCで新しく起動するClaude Codeセッションに使います。1つのセッションで計画から実装まで
          進めるため、通常はSonnetが適しています。全リポジトリ共通です。Haikuはauto
          modeが動作しないため選べません（
          <a
            href="https://github.com/anthropics/claude-code/issues/43235"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            anthropics/claude-code#43235
          </a>
          ）。
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="codex-model">Codex：サブPCでの計画・実装</Label>
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
          サブPCで新しく起動するCodex CLIセッションに使います。通常はTerra、難しいIssueはSol、
          単純な修正を優先する場合はLunaが適しています。全リポジトリ共通です。
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="app-ai-model">アプリ内AI：要約・検索・文章整理</Label>
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
          Issueとコメントの要約、類似Issue検索、本文整理、並び替え、Issue作成補助に使います。
          定型処理が中心のため、通常はHaikuが適しています。
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="app-ai-model-reasoning">アプリ内AI：原因診断・新規アプリ相談</Label>
        <Select
          value={appAiModelReasoning}
          onValueChange={(value) => setAppAiModelReasoning(value as AppAiModel)}
        >
          <SelectTrigger id="app-ai-model-reasoning" className="w-full">
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
          手作業が失敗した原因の診断と、新規アプリの構成相談に使います。判断力が必要なため、
          通常はSonnetが適しています。GPTを選ぶとOpenAI API、Claudeを選ぶとAnthropic APIを使います。
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
