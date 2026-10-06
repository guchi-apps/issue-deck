import { STEP_SCHEMA, type CallModel } from "@/lib/chat/investigation/agent";
import { callClaudeMessages, getAppAiToken } from "@/lib/claude/request";

/**
 * 調査エージェントのモデル呼び出し（#4045）。アプリ内AIの共通入口（`callClaudeMessages`）を使い、
 * 選択中のモデル・プロバイダ設定と消費量の計上をそのまま引き継ぐ（呼び出しロジックは複製しない）。
 */
export const callInvestigationModel: CallModel = async ({ system, messages, timeoutMs }) => {
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
