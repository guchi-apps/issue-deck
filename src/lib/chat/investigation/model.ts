import { STEP_SCHEMA, type CallModel } from "@/lib/chat/investigation/agent";
import { parseAiExecutionProvider, resolveAppAiModel } from "@/lib/app-settings";
import { callClaudeMessages, getAppAiToken } from "@/lib/claude/request";
import { db } from "@/lib/db";

/**
 * チャット調査をどこで実行するか（#4109）。**AI実行プロバイダーがCodexなら、サブPCのCodex CLI**
 * （ChatGPT/Codexのサブスク枠）で、OpenAI APIは使わない。Claudeなら従来どおりアプリ内AIの
 * 共通入口（`callClaudeMessages`）で同期に呼ぶ。
 *
 * Codexのときのモデルは`appAiModelReasoning`の個別指定、無ければCodexの既定（Terra）。Claude系を
 * 個別指定していても実行先はCodexのままで、`Codex(unsupported_model)`として断る（黙って別の
 * 実行先へ切り替えない）。
 */
export type ChatExecution = { mode: "codex"; model: string } | { mode: "api" };

export async function resolveChatExecution(): Promise<ChatExecution> {
  const setting = await db.appSetting
    .findUnique({ where: { id: 1 }, select: { appAiModelReasoning: true, aiExecutionProvider: true } })
    .catch(() => null);
  if (parseAiExecutionProvider(setting?.aiExecutionProvider) !== "codex") return { mode: "api" };
  return {
    mode: "codex",
    model: resolveAppAiModel(setting?.appAiModelReasoning, setting?.aiExecutionProvider, true),
  };
}

/**
 * 調査エージェントのモデル呼び出し（#4045）。アプリ内AIの共通入口（`callClaudeMessages`）を使い、
 * 選択中のモデル・プロバイダ設定と消費量の計上をそのまま引き継ぐ（呼び出しロジックは複製しない）。
 *
 * **プロバイダーがCodexのときはここを通さない**（`createCodexCallModel`を使う）。設定が途中で
 * 切り替わってここへ来た場合も、OpenAI APIへは逃がさずに断る（要件10）。
 */
export const callInvestigationModel: CallModel = async ({ system, messages, timeoutMs }) => {
  const execution = await resolveChatExecution();
  if (execution.mode === "codex") {
    return { ok: false, reason: "Codex(provider_changed) 実行先がCodexに切り替わりました。送り直してください" };
  }
  const token = await getAppAiToken("chat_investigation");
  if (!token) return { ok: false, reason: "AIの認証情報が設定されていません" };
  try {
    const { response, json, error } = await callClaudeMessages({
      feature: "chat_investigation",
      token,
      timeoutMs,
      body: {
        max_tokens: 3000,
        system,
        messages,
        output_config: { format: { type: "json_schema", schema: STEP_SCHEMA } },
      },
    });
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}${error?.code ? ` ${error.code}` : ""}` };
    }
    if (json?.stop_reason === "max_tokens") return { ok: false, reason: "応答が長すぎて途中で切れました" };
    const text = json?.content?.find((block) => block.type === "text")?.text?.trim();
    return text ? { ok: true, text } : { ok: false, reason: "応答が空でした" };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error && cause.name === "TimeoutError" ? "時間切れ" : "通信に失敗しました" };
  }
};
