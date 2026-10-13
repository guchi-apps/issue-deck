import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/review-agent/service", () => ({
  callReviewAgentTool: call,
  listReviewAgentTools: () => [{ name: "get_fix_status", description: "d", scope: "read", inputSchema: { type: "object" } }],
}));

import { handleMcpMessage } from "@/lib/review-agent/mcp";

const principal = { tokenId: "t", userId: "u", name: "n", scopes: ["read" as const], repositories: ["o/r"] };
beforeEach(() => call.mockReset());

describe("MCP（JSON-RPC）", () => {
  it("initializeでツール機能を宣言し、通知には応答しない", async () => {
    const r = await handleMcpMessage(principal, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(r).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "issue-deck-review-agent" } } });
    expect(await handleMcpMessage(principal, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });
  it("tools/listはサービスと同じ定義を返す", async () => {
    const r = await handleMcpMessage(principal, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((r?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(["get_fix_status"]);
  });
  it("tools/callは成功をJSONテキストで、拒否をisErrorで返す", async () => {
    call.mockResolvedValueOnce({ ok: true, data: { a: 1 } });
    const ok = await handleMcpMessage(principal, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_fix_status", arguments: { repository: "o/r", issue: 1 } } });
    expect(ok?.result).toMatchObject({ isError: false });
    expect(JSON.parse(((ok?.result as { content: Array<{ text: string }> }).content[0]).text)).toEqual({ data: { a: 1 } });
    expect(call).toHaveBeenCalledWith(principal, "get_fix_status", { repository: "o/r", issue: 1 });
    call.mockResolvedValueOnce({ ok: false, status: 409, error: "stale_sha", message: "旧", refetchRequired: true });
    const ng = await handleMcpMessage(principal, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "x" } });
    expect(ng?.result).toMatchObject({ isError: true });
    expect(JSON.parse(((ng?.result as { content: Array<{ text: string }> }).content[0]).text)).toMatchObject({ error: "stale_sha", refetchRequired: true });
  });
  it("未知のメソッドと不正なメッセージはJSON-RPCエラー", async () => {
    expect(await handleMcpMessage(principal, { jsonrpc: "2.0", id: 5, method: "nope" })).toMatchObject({ error: { code: -32601 } });
    expect(await handleMcpMessage(principal, "x")).toMatchObject({ error: { code: -32600 } });
  });
});
