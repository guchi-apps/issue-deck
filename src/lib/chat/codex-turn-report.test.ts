import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  job: null as null | { kind: string; claimedByHost: string; status: string },
  run: null as null | { id: string; stepRequest: unknown; currentJobId: string; stepResult?: string | null; stepError?: string | null },
  reports: [] as { status: string }[],
  usage: [] as unknown[],
}));

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/claude/api-usage", () => ({ recordClaudeApiCall: (call: unknown) => state.usage.push(call) }));
vi.mock("@/lib/dispatch/jobs", () => ({
  reportDispatchJob: async (params: { status: string }) => {
    state.reports.push(params);
    return { ok: true };
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    dispatchJob: { findUnique: async () => state.job },
    chatRun: {
      findFirst: async () => state.run,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (state.run) Object.assign(state.run, data);
        return { count: state.run ? 1 : 0 };
      },
    },
  },
}));

import { fetchChatTurnRequest, reportChatTurnResult, runChatTurnTool } from "@/lib/chat/codex-turn-report";

const request = { model: "gpt-6-sol", system: "S", messages: [{ role: "user", content: "相談" }], schema: { type: "object" } };

beforeEach(() => {
  state.job = { kind: "CHAT_TURN", claimedByHost: "subpc", status: "CLAIMED" };
  state.run = { id: "run1", stepRequest: request, currentJobId: "job1" };
  state.reports = [];
  state.usage = [];
});

describe("CHAT_TURNの受け渡し（#4109）", () => {
  it("取ったホストにだけプロンプトを渡し、ジョブを実行中にする", async () => {
    const result = await fetchChatTurnRequest({ jobId: "job1", host: "subpc" });
    expect(result.ok && result.body.model).toBe("gpt-6-sol");
    expect(result.ok && result.body.prompt).toContain("相談");
    expect(state.reports[0]?.status).toBe("running");

    const other = await fetchChatTurnRequest({ jobId: "job1", host: "other" });
    expect(other).toMatchObject({ ok: false, status: 403 });
  });

  it("CHAT_TURN以外のジョブからは読ませない", async () => {
    state.job = { kind: "LAUNCH", claimedByHost: "subpc", status: "CLAIMED" };
    expect(await fetchChatTurnRequest({ jobId: "job1", host: "subpc" })).toMatchObject({ ok: false, status: 404 });
  });

  it("成功は回答待ちへ書いてからジョブを閉じ、Codex CLIの利用として計上する", async () => {
    await reportChatTurnResult({ jobId: "job1", host: "subpc", status: "succeeded", output: '{"action":"final"}', errorKind: null, usage: { input_tokens: 5 } });
    expect(state.run?.stepResult).toBe('{"action":"final"}');
    expect(state.reports.at(-1)?.status).toBe("succeeded");
    expect(state.usage).toHaveLength(1);
  });

  it("失敗の種別は既知の語だけを通し、空の成功は bad_output にする", async () => {
    await reportChatTurnResult({ jobId: "job1", host: "subpc", status: "failed", output: null, errorKind: "rm -rf", usage: null });
    expect(state.run?.stepError).toBe("codex_error");
    state.run = { id: "run1", stepRequest: request, currentJobId: "job1" };
    await reportChatTurnResult({ jobId: "job1", host: "subpc", status: "succeeded", output: "  ", errorKind: null, usage: null });
    expect(state.run?.stepError).toBe("bad_output");
    expect(state.reports.at(-1)?.status).toBe("failed");
    expect(state.usage).toHaveLength(0);
  });
});

describe("セッション型のツール受け口（#4199）", () => {
  it("実行の記録（サーバーのメモリ）が無ければ409で断り、ブリッジに終わらせる", async () => {
    const result = await runChatTurnTool({ jobId: "job1", host: "subpc", name: "get_issue", args: { number: 1 } });
    expect(result).toMatchObject({ ok: false, status: 409, error: "session_missing" });
  });

  it("取ったホスト以外・待っていない回答待ちからは呼べない", async () => {
    expect(await runChatTurnTool({ jobId: "job1", host: "other", name: "get_issue", args: {} })).toMatchObject({ ok: false, status: 403 });
    state.run = null;
    expect(await runChatTurnTool({ jobId: "job1", host: "subpc", name: "get_issue", args: {} })).toMatchObject({ ok: false, status: 409 });
  });
});
