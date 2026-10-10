import {
  appAiProvider,
  parseClaudeLocalModel,
  parseCodexLocalModel,
  resolveAppAiModel,
  type AppAiModel,
  type ClaudeLocalModel,
  type CodexLocalModel,
} from "@/lib/app-settings";

/**
 * リリース全体のAIレビュー（`RELEASE_REVIEW`・#4238）の担当。**アプリ内AIの「判断力が要る用途」の
 * モデル（`appAiModelReasoning`）に従う**——差分全体を1回で見る重い判断なので、要約用の軽いモデルではなく
 * 推論用の設定を使う。OpenAI系のモデルならCodex、それ以外はClaude Codeで実行する。
 *
 * 画面（AIモデル設定）とジョブを積む処理が同じ関数を使うので、表示と実際の担当がずれない。
 */
export type ReleaseReviewAssignee = {
  agent: "claude" | "codex";
  /** 設定で決まったアプリ内AIのモデルID */
  appModel: AppAiModel;
  /** ローカルのClaude Codeへ渡すエイリアス（agentがclaudeのときだけ） */
  claudeModel: ClaudeLocalModel | null;
  /** ローカルのCodexへ渡すモデル名（agentがcodexのときだけ） */
  codexModel: CodexLocalModel | null;
};

const CLAUDE_ALIASES: Readonly<Record<string, ClaudeLocalModel>> = {
  "claude-fable-5-1": "fable",
  "claude-opus-5-5": "opus",
  "claude-sonnet-5-5": "sonnet",
  // Haikuはローカルセッションのauto modeで動かないため、全体レビューではSonnetへ読み替える
  "claude-haiku-4-5": "sonnet",
};

export function resolveReleaseReviewAssignee(
  setting: { appAiModelReasoning?: unknown; aiExecutionProvider?: unknown } | null | undefined,
): ReleaseReviewAssignee {
  const appModel = resolveAppAiModel(setting?.appAiModelReasoning, setting?.aiExecutionProvider, true);
  if (appAiProvider(appModel) === "openai") {
    return { agent: "codex", appModel, claudeModel: null, codexModel: parseCodexLocalModel(appModel) };
  }
  return {
    agent: "claude",
    appModel,
    claudeModel: parseClaudeLocalModel(CLAUDE_ALIASES[appModel] ?? "sonnet"),
    codexModel: null,
  };
}

/** 画面用の表記（例: `Claude Code · opus`） */
export function describeReleaseReviewAssignee(assignee: ReleaseReviewAssignee): string {
  return assignee.agent === "codex"
    ? `Codex · ${assignee.codexModel ?? assignee.appModel}`
    : `Claude Code · ${assignee.claudeModel ?? assignee.appModel}`;
}
