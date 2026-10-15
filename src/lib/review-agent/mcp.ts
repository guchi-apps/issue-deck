import type { ReviewAgentPrincipal } from "@/lib/review-agent/auth";
import { callReviewAgentTool, listReviewAgentTools } from "@/lib/review-agent/service";

/**
 * 全体レビュー・修正の外部エージェント向けMCPサーバー（#4588）。Streamable HTTPのJSON-RPCを依存パッケージなしで実装する
 * （SSEは使わず、1リクエスト1応答のJSONだけを返す）。**ツールの一覧・実行は`service.ts`と同じ定義を呼ぶ**ので、RESTと結果が一致する。
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const SERVER_INFO = { name: "issue-deck-review-agent", version: "1.0.0" };

type JsonRpcId = string | number | null;
export type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const rpcError = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

/** 1メッセージを処理する。通知（idなし）は応答を持たないのでnullを返す */
export async function handleMcpMessage(principal: ReviewAgentPrincipal, message: unknown): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return rpcError(null, -32600, "Invalid Request");
  const { id, method, params } = message as { id?: JsonRpcId; method?: unknown; params?: unknown };
  if (typeof method !== "string") return rpcError(id ?? null, -32600, "Invalid Request");
  const isNotification = id === undefined;
  const reply = (result: unknown): JsonRpcResponse | null => (isNotification ? null : { jsonrpc: "2.0", id: id ?? null, result });

  if (method === "initialize") {
    const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? (asked as string) : MCP_PROTOCOL_VERSIONS[0];
    return reply({
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "全体レビューと修正の状態を取得し、担当の取得・修正・独立レビュー・テストの報告で続きを実行します。報告の前に get_fix_status で epoch と対象SHAを確かめ、更新には操作ごとに新しい idempotencyKey を付けてください。本番マージ・公開の承認は含みません。",
    });
  }
  if (method.startsWith("notifications/")) return null;
  if (method === "ping") return reply({});
  if (method === "tools/list") {
    return reply({
      tools: listReviewAgentTools().map((t) => ({
        name: t.name,
        description: `${t.description}（必要な操作範囲: ${t.scope}）`,
        inputSchema: t.inputSchema,
      })),
    });
  }
  if (method === "tools/call") {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof name !== "string") return rpcError(id ?? null, -32602, "Invalid params: name");
    const result = await callReviewAgentTool(principal, name, args);
    const body = result.ok
      ? { ...(result.replayed ? { replayed: true } : {}), data: result.data }
      : { error: result.error, message: result.message, refetchRequired: result.refetchRequired ?? false, ...(result.details ? { details: result.details } : {}) };
    return reply({ content: [{ type: "text", text: JSON.stringify(body) }], isError: !result.ok });
  }
  return isNotification ? null : rpcError(id ?? null, -32601, `Method not found: ${method}`);
}
