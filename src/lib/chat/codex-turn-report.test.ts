import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  job: null as null | { kind: string; claimedByHost: string; status: string },
  run: null as null | { id: string; stepRequest: unknown; currentJobId: string; stepResult?: string | null; stepError?: string | null },
  appRun: null as null | { id: string; feature: string; stepRequest: unknown; currentJobId: string; stepResult?: string | null; stepError?: string | null; status?: string },
  reports: [] as { status: string; message?: string }[],
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
    appAiCodexRun: {
      findFirst: async () => state.appRun,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (state.appRun) Object.assign(state.appRun, data);
        return { count: state.appRun ? 1 : 0 };
      },
    },
  },
}));

import { fetchChatTurnRequest, reportChatTurnResult, runChatTurnTool } from "@/lib/chat/codex-turn-report";

const request = { model: "gpt-6-sol", system: "S", messages: [{ role: "user", content: "相談" }], schema: { type: "object" } };

beforeEach(() => {
  state.job = { kind: "CHAT_TURN", claimedByHost: "subpc", status: "CLAIMED" };
  state.run = { id: "run1", stepRequest: request, currentJobId: "job1" };
  state.appRun = null;
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

describe("アプリ内AIの単発実行（#5067）", () => {
  const appRequest = {
    model: "gpt-6-luna",
    system: "要約係",
    messages: [{ role: "user", content: "コメントを要約して" }],
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    textWrapped: true,
  };

  beforeEach(() => {
    state.run = null;
    state.appRun = { id: "app1", feature: "comment_summary", stepRequest: appRequest, currentJobId: "job1", status: "running" };
  });

  it("ツールもMCPも付けない単発の依頼として渡す", async () => {
    const result = await fetchChatTurnRequest({ jobId: "job1", host: "subpc" });
    expect(result.ok && result.body).toMatchObject({ model: "gpt-6-luna", mode: null, tools: [], schema: appRequest.schema });
    expect(result.ok && result.body.prompt).toContain("コメントを要約して");
    expect(result.ok && result.body.prompt).toContain("text 欄");
    expect(state.reports[0]?.message).toContain("アプリ内AI");
  });

  it("成功は待ち手へ書き、呼び出した機能の`codex-cli/<model>`として使用量を記録する", async () => {
    await reportChatTurnResult({ jobId: "job1", host: "subpc", status: "succeeded", output: '{"text":"要約"}', errorKind: null, usage: { input_tokens: 7, output_tokens: 3 } });
    expect(state.appRun).toMatchObject({ stepResult: '{"text":"要約"}', status: "succeeded" });
    expect(state.usage[0]).toMatchObject({ feature: "comment_summary", model: "codex-cli/gpt-6-luna", tokens: { inputTokens: 7, outputTokens: 3 } });
  });

  it("失敗は種別を待ち手へ書き、使用量は記録しない", async () => {
    await reportChatTurnResult({ jobId: "job1", host: "subpc", status: "failed", output: null, errorKind: "usage_limit", usage: null });
    expect(state.appRun).toMatchObject({ stepError: "usage_limit", status: "failed" });
    expect(state.usage).toHaveLength(0);
  });

  it("ツールの受け口は使わせない", async () => {
    const result = await runChatTurnTool({ jobId: "job1", host: "subpc", name: "get_issue", args: {} });
    expect(result).toMatchObject({ ok: false, status: 409, error: "session_missing" });
  });
  describe("画像付きの依頼（#5068）", () => {
    const images = () =>
      ((globalThis as { __issueDeckAppAiCodexImages?: Map<string, unknown> }).__issueDeckAppAiCodexImages ??= new Map());

    beforeEach(() => {
      state.appRun = {
        id: "app1",
        feature: "issue_image_extract",
        stepRequest: { ...appRequest, imageCount: 1 },
        currentJobId: "job1",
        status: "running",
      };
      images().set("app1", [{ mediaType: "image/png", data: "AAAA" }]);
    });

    it("画像を受け取れるスクリプトには、待ち手のメモリから画像を渡す", async () => {
      const result = await fetchChatTurnRequest({ jobId: "job1", host: "subpc", acceptsImages: true });
      expect(result.ok && result.body.images).toEqual([{ mediaType: "image/png", data: "AAAA" }]);
      expect(result.ok && result.body.prompt).toContain("画像を1枚添付している");
      expect(state.reports[0]?.status).toBe("running");
    });

    it("古いスクリプトには渡さず、待ち手へ image_host_outdated を書いてジョブを閉じる", async () => {
      const result = await fetchChatTurnRequest({ jobId: "job1", host: "subpc" });
      expect(result).toMatchObject({ ok: false, status: 409, error: "images_unsupported" });
      expect(state.appRun).toMatchObject({ stepError: "image_host_outdated", status: "failed" });
      expect(state.reports.map((r) => r.status)).toEqual(["failed"]);
    });

    it("待ち手のメモリに画像が無ければ（再起動など）渡さない", async () => {
      images().delete("app1");
      expect(await fetchChatTurnRequest({ jobId: "job1", host: "subpc", acceptsImages: true })).toMatchObject({
        ok: false,
        error: "request_missing",
      });
      expect(state.reports).toHaveLength(0);
    });
  });
});
