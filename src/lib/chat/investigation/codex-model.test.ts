import { beforeEach, describe, expect, it, vi } from "vitest";

type JobRow = { id: string; status: string; kind: string; targetHost: string; activeKey: string | null };
type RunRow = { id: string; currentJobId: string | null; stepResult: string | null; stepError: string | null; stepRequest: unknown; phase: string };

const state = vi.hoisted(() => ({
  hosts: [] as { name: string; lastSeenAt: Date; chatCodexCapable: boolean | null }[],
  jobs: new Map<string, JobRow>(),
  runs: new Map<string, RunRow>(),
  /** ポーリング1回ごとに呼ぶ（サブPC側の動きを模す） */
  onPoll: null as null | ((jobId: string) => void),
  usage: [] as unknown[],
}));

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));

vi.mock("@/lib/claude/api-usage", () => ({
  recordClaudeApiCall: (call: unknown) => state.usage.push(call),
}));

vi.mock("@/lib/db", () => ({
  db: {
    dispatchHost: { findMany: async () => state.hosts },
    dispatchJob: {
      create: async ({ data }: { data: Omit<JobRow, "id"> }) => {
        const row = { ...data, id: `job${state.jobs.size + 1}` } as JobRow;
        state.jobs.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        state.onPoll?.(where.id);
        return state.jobs.get(where.id) ?? null;
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: Partial<JobRow> }) => {
        const row = state.jobs.get(where.id);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
    },
    chatRun: {
      update: async ({ where, data }: { where: { id: string }; data: Partial<RunRow> }) => {
        const row = state.runs.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => state.runs.get(where.id) ?? null,
    },
  },
}));

import { buildCodexPrompt, createCodexCallModel, recordCodexChatUsage } from "@/lib/chat/investigation/codex-model";
import { describeUnavailable } from "@/lib/chat/investigation/reply";

const now = Date.now();

function setup(host: { chatCodexCapable: boolean | null; online?: boolean } | null) {
  state.hosts = host
    ? [{ name: "subpc", lastSeenAt: new Date(host.online === false ? now - 3_600_000 : Date.now()), chatCodexCapable: host.chatCodexCapable }]
    : [];
  state.jobs.clear();
  state.runs.clear();
  state.runs.set("run1", { id: "run1", currentJobId: null, stepResult: null, stepError: null, stepRequest: null, phase: "" });
  state.onPoll = null;
  state.usage = [];
}

function model(modelName = "gpt-6-sol") {
  let t = 0;
  return createCodexCallModel({
    runId: "run1",
    model: modelName,
    requestedByUserId: "u1",
    sleep: async () => undefined,
    // ポーリング1回ごとに1秒進める
    clock: () => (t += 1_000),
  });
}

const input = { system: "S", messages: [{ role: "user" as const, content: "相談" }], timeoutMs: 120_000 };

describe("createCodexCallModel（サブPCのCodex CLIでモデルを呼ぶ。#4109）", () => {
  beforeEach(() => setup({ chatCodexCapable: true }));

  it("サブPCが返した最終メッセージをそのまま返す（OpenAI APIは呼ばない）", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    state.onPoll = (jobId) => {
      const job = state.jobs.get(jobId)!;
      if (job.status === "QUEUED") job.status = "RUNNING";
      else state.runs.get("run1")!.stepResult = '{"action":"final"}';
    };
    const result = await model()(input);
    expect(result).toEqual({ ok: true, text: '{"action":"final"}' });
    const job = [...state.jobs.values()][0];
    expect(job.kind).toBe("CHAT_TURN");
    expect(job.activeKey).toBe("chat-turn:run1");
    expect(state.runs.get("run1")!.phase).toContain("Codexで回答中");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("サブPCがオフラインならジョブを積まずに offline で断る", async () => {
    setup({ chatCodexCapable: true, online: false });
    const result = await model()(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && describeUnavailable(result.reason).kind).toBe("codex_offline");
    expect(state.jobs.size).toBe(0);
  });

  it("pollerが未対応なら unsupported（APIへは逃がさない）", async () => {
    setup({ chatCodexCapable: null });
    const result = await model()(input);
    expect(!result.ok && describeUnavailable(result.reason).kind).toBe("codex_unsupported");
  });

  it("Codex CLIで動かせないモデルは unsupported_model", async () => {
    const result = await model("claude-sonnet-5-5")(input);
    expect(!result.ok && describeUnavailable(result.reason).kind).toBe("codex_unsupported_model");
    expect(state.jobs.size).toBe(0);
  });

  it("受け取られないまま30秒たてばジョブを取り消し、not_claimed で返す", async () => {
    const result = await model()(input);
    expect(!result.ok && describeUnavailable(result.reason).kind).toBe("codex_not_claimed");
    expect([...state.jobs.values()][0].status).toBe("CANCELED");
  });

  it("サブPCが返した失敗の種別（利用枠超過）を区別して返す", async () => {
    state.onPoll = (jobId) => {
      state.jobs.get(jobId)!.status = "FAILED";
      state.runs.get("run1")!.stepError = "usage_limit";
    };
    const result = await model()(input);
    const failure = !result.ok ? describeUnavailable(result.reason) : null;
    expect(failure?.kind).toBe("codex_usage_limit");
    // API残高切れ（credit_balance_exhausted）とは別の案内
    expect(failure?.label).toContain("Codex");
  });

  it("受け取られた後に応答が来なければ timeout", async () => {
    state.onPoll = (jobId) => {
      state.jobs.get(jobId)!.status = "RUNNING";
    };
    const result = await model()({ ...input, timeoutMs: 5_000 });
    expect(!result.ok && describeUnavailable(result.reason).kind).toBe("codex_timeout");
  });
});

describe("buildCodexPrompt", () => {
  it("system・会話の順に1本へ畳み、役割を区切る", () => {
    const prompt = buildCodexPrompt({
      system: "SYSTEM",
      messages: [
        { role: "user", content: "質問" },
        { role: "assistant", content: "{}" },
      ],
    });
    expect(prompt.startsWith("SYSTEM")).toBe(true);
    expect(prompt).toContain("<user>\n質問\n</user>");
    expect(prompt).toContain("<assistant>\n{}\n</assistant>");
  });
});

describe("recordCodexChatUsage", () => {
  it("OpenAI APIの`gpt-*`と混ざらないよう、実行先を前に付けて計上する", () => {
    setup(null);
    recordCodexChatUsage("gpt-6-sol", { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 });
    expect(state.usage).toEqual([
      {
        feature: "chat_investigation",
        model: "codex-cli/gpt-6-sol",
        tokens: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 40, cacheCreationTokens: 0 },
      },
    ]);
  });
});
