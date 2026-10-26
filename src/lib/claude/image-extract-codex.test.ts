import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 画像からの変更内容の抽出を、GPT系の選択時にCodex経路で通しで動かす（#5068）。
 * 振り分け（`request.ts`）・ジョブ投入と待ち（`app-ai-codex.ts`）・サブPCとの受け渡し（`codex-turn-report.ts`）は
 * 本物を使い、DBとサブPCの動きだけを模す。Claude API・OpenAI APIへは一度も送らないことを確かめる
 */

type Row = Record<string, unknown> & { id: string };

const state = vi.hoisted(() => ({
  jobs: new Map<string, Row>(),
  runs: new Map<string, Row>(),
  /** サブPCが受け取った依頼 */
  fetched: [] as unknown[],
  /** サブPCが`images=1`を付けて取りに来るか（古いスクリプトを模すときはfalse） */
  acceptsImages: true,
}));

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/claude/api-usage", () => ({ recordClaudeApiCall: vi.fn() }));
vi.mock("@/lib/dispatch/jobs", () => ({
  reportDispatchJob: async ({ jobId, status }: { jobId: string; status: string }) => {
    const job = state.jobs.get(jobId);
    if (job) job.status = { running: "RUNNING", succeeded: "SUCCEEDED", failed: "FAILED" }[status] ?? job.status;
    return { ok: true };
  },
}));

function matches(row: Row, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

vi.mock("@/lib/db", () => ({
  db: {
    appSetting: { findUnique: async () => ({ appAiModel: "gpt-6-luna", appAiModelReasoning: "gpt-6-luna", aiExecutionProvider: null }) },
    dispatchHost: { findMany: async () => [{ name: "subpc", lastSeenAt: new Date(), chatCodexCapable: true }] },
    dispatchJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `job${state.jobs.size + 1}` };
        state.jobs.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => state.jobs.get(where.id) ?? null,
      updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.jobs.get(where.id);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
    },
    chatRun: { findFirst: async () => null },
    appAiCodexRun: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { currentJobId: null, stepResult: null, stepError: null, ...data, id: `run${state.runs.size + 1}` };
        state.runs.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.runs.get(where.id)!;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = [...state.runs.values()].filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
      findUnique: async ({ where }: { where: { id: string } }) => state.runs.get(where.id) ?? null,
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        [...state.runs.values()].find((row) => matches(row, where)) ?? null,
      delete: async ({ where }: { where: { id: string } }) => state.runs.delete(where.id),
      deleteMany: async () => ({ count: 0 }),
    },
  },
}));

// ジョブが積まれたら、サブPC（poller＋`run-chat-codex.sh`）の動きを模す
vi.mock("@/lib/dispatch/wake-notify", () => ({
  notifyDispatchHostWake: () => {
    setTimeout(async () => {
      const { fetchChatTurnRequest, reportChatTurnResult } = await import("@/lib/chat/codex-turn-report");
      const job = [...state.jobs.values()].at(-1)!;
      Object.assign(job, { status: "CLAIMED", claimedByHost: "subpc" });
      const result = await fetchChatTurnRequest({ jobId: job.id, host: "subpc", acceptsImages: state.acceptsImages });
      if (!result.ok) return;
      state.fetched.push(result.body);
      await reportChatTurnResult({
        jobId: job.id,
        host: "subpc",
        status: "succeeded",
        output: JSON.stringify({ text: '{"items":["（画像1）「保存」ボタンを削除する（×印）"],"unreadable":false}' }),
        errorKind: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }, 0);
  },
}));

import { generateImageExtract } from "@/lib/claude/image-extract";
import { getAppAiToken } from "@/lib/claude/request";
import { UPLOADED_IMAGE_DIR } from "@/lib/images/image-storage";

const NAME = "eeeeeeee-1111-2222-3333-444444445068.png";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

beforeEach(async () => {
  state.jobs.clear();
  state.runs.clear();
  state.fetched = [];
  state.acceptsImages = true;
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("外部APIへ送ってはいけない"))));
  await mkdir(UPLOADED_IMAGE_DIR, { recursive: true });
  await writeFile(path.join(UPLOADED_IMAGE_DIR, NAME), PNG);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(path.join(UPLOADED_IMAGE_DIR, NAME), { force: true });
});

describe("GPT系選択時の画像からの変更内容の抽出（#5068）", () => {
  it("サブPCのCodex CLIへ画像を渡して読み取り結果を返し、Claude API・OpenAI APIへは送らない", async () => {
    const token = await getAppAiToken("issue_image_extract");
    const result = await generateImageExtract(token!, [`https://example.test/api/issues/images/${NAME}`]);

    expect(result).toEqual({ items: ["（画像1）「保存」ボタンを削除する（×印）"], unreadable: false });
    expect(state.fetched).toHaveLength(1);
    expect(state.fetched[0]).toMatchObject({
      model: "gpt-6-luna",
      images: [{ mediaType: "image/png", data: PNG.toString("base64") }],
    });
    expect((state.fetched[0] as { prompt: string }).prompt).toContain("［添付画像1］");
    expect(fetch).not.toHaveBeenCalled();
    // 処理が終われば待ちの行は消え、DBへ書いた依頼にも画像の本体は残らない
    expect(state.runs.size).toBe(0);
  });

  it("画像を受け取れない古いサブPCのスクリプトには渡さず、更新を促すエラーで止まる", async () => {
    state.acceptsImages = false;
    const token = await getAppAiToken("issue_image_extract");
    await expect(generateImageExtract(token!, [`https://example.test/api/issues/images/${NAME}`])).rejects.toThrow(
      /サブPCのチェックアウトを更新してください/,
    );
    expect(state.fetched).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
