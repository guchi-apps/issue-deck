import { beforeEach, describe, expect, it, vi } from "vitest";

type JobRow = { id: string; status: string; kind: string; targetHost: string; activeKey: string | null; codexModel?: string };
type RunRow = {
  id: string;
  feature: string;
  model: string;
  status: string;
  currentJobId: string | null;
  stepRequest: unknown;
  stepResult: string | null;
  stepError: string | null;
};

const state = vi.hoisted(() => ({
  hosts: [] as { name: string; lastSeenAt: Date; chatCodexCapable: boolean | null }[],
  jobs: new Map<string, JobRow>(),
  runs: new Map<string, RunRow>(),
  /** ポーリング1回ごとに呼ぶ（サブPC側の動きを模す） */
  onPoll: null as null | ((jobId: string, run: RunRow | undefined) => void),
  deletedRuns: [] as string[],
}));

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/dispatch/wake-notify", () => ({ notifyDispatchHostWake: vi.fn() }));
vi.mock("@/lib/claude/api-usage", () => ({ recordClaudeApiCall: vi.fn() }));

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
        const run = [...state.runs.values()].find((r) => r.currentJobId === where.id);
        state.onPoll?.(where.id, run);
        return state.jobs.get(where.id) ?? null;
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: Partial<JobRow> }) => {
        const row = state.jobs.get(where.id);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
    },
    appAiCodexRun: {
      create: async ({ data }: { data: Omit<RunRow, "id" | "currentJobId" | "stepResult" | "stepError"> }) => {
        const row: RunRow = { currentJobId: null, stepResult: null, stepError: null, ...data, id: `run${state.runs.size + 1}` };
        state.runs.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<RunRow> }) => {
        const row = state.runs.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => state.runs.get(where.id) ?? null,
      delete: async ({ where }: { where: { id: string } }) => {
        state.deletedRuns.push(where.id);
        state.runs.delete(where.id);
      },
      deleteMany: async () => ({ count: 0 }),
    },
  },
}));

import {
  AppAiCodexError,
  buildAppAiCodexPrompt,
  findAppAiCodexImages,
  normalizeCodexSchema,
  readCodexOutput,
  runAppAiOnCodex,
  toCodexRequest,
} from "@/lib/claude/app-ai-codex";

const now = Date.now();
let clockNow = now;
const clock = () => clockNow;
/** 待ちのたびに時計を1秒進める（実時間では待たない） */
const sleep = async (ms: number) => {
  clockNow += ms;
};

const summaryBody = { max_tokens: 1024, system: "要約係", messages: [{ role: "user", content: "コメントを要約して" }] };

function expectKind(promise: Promise<unknown>, kind: string) {
  return expect(promise).rejects.toSatisfy((e: unknown) => e instanceof AppAiCodexError && e.kind === kind);
}

beforeEach(() => {
  clockNow = now;
  state.hosts = [{ name: "subpc", lastSeenAt: new Date(now), chatCodexCapable: true }];
  state.jobs.clear();
  state.runs.clear();
  state.deletedRuns = [];
  state.onPoll = null;
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("外部APIへ送ってはいけない"))));
});

describe("Claude Messagesの本文をCodexの依頼へ変える（#5067）", () => {
  it("自由文の機能は{text}1欄のスキーマで包み、systemと会話をテキストへ畳む", () => {
    const { request } = toCodexRequest("gpt-6-luna", {
      system: [{ type: "text", text: "役割" }],
      messages: [{ role: "user", content: [{ type: "text", text: "本文" }] }],
    });
    expect(request.textWrapped).toBe(true);
    expect(request.schema).toMatchObject({ required: ["text"], additionalProperties: false });
    expect(request.system).toBe("役割");
    expect(request.messages).toEqual([{ role: "user", content: "本文" }]);
    expect(buildAppAiCodexPrompt(request)).toContain("text 欄");
  });

  it("json_schemaの構造化出力はそのスキーマをCodexの制約（全項目required・追加項目なし）へ寄せて渡す", () => {
    const { request } = toCodexRequest("gpt-6-luna", {
      messages: [],
      output_config: {
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] },
        },
      },
    });
    expect(request.textWrapped).toBe(false);
    expect(request.schema).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: ["number", "null"] } },
      required: ["a", "b"],
      additionalProperties: false,
    });
  });

  it("入れ子のオブジェクト・anyOfの中も正規化する", () => {
    const normalized = normalizeCodexSchema({
      type: "object",
      properties: { d: { anyOf: [{ type: "object", properties: { x: { type: "string" } } }, { type: "null" }] } },
      required: ["d"],
    }) as { properties: { d: { anyOf: { required?: string[]; additionalProperties?: boolean }[] } } };
    expect(normalized.properties.d.anyOf[0]).toMatchObject({ required: ["x"], additionalProperties: false });
  });

  it("画像は目印へ置き換えて分け、依頼には枚数だけを残す（#5068）", () => {
    const { request, images } = toCodexRequest("gpt-6-luna", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "（画像1の元画像）" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
            { type: "text", text: "読んで" },
          ],
        },
      ],
    });
    expect(images).toEqual([
      { mediaType: "image/png", data: "AAAA" },
      { mediaType: "image/jpeg", data: "BBBB" },
    ]);
    expect(request.imageCount).toBe(2);
    expect(request.messages[0].content).toBe("（画像1の元画像）\n\n［添付画像1］\n\n［添付画像2］\n\n読んで");
    // DBへ書く依頼に画像の本体は入れない
    expect(JSON.stringify(request)).not.toContain("AAAA");
    expect(buildAppAiCodexPrompt(request)).toContain("画像を2枚添付している");
  });

  it("PDFなどの文書・base64でない画像は送る前に document_unsupported で断る", () => {
    for (const block of [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } },
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "AAAA" } },
    ]) {
      expect(() => toCodexRequest("gpt-6-luna", { messages: [{ role: "user", content: [block] }] })).toThrow(
        expect.objectContaining({ kind: "document_unsupported" }),
      );
    }
  });

  it("受け取った出力は包みを外し、JSONでない・text欄が無い出力は bad_output にする", () => {
    expect(readCodexOutput('{"text":"答え"}', true)).toBe("答え");
    expect(readCodexOutput('{"keys":["a#1"]}', false)).toBe('{"keys":["a#1"]}');
    expect(() => readCodexOutput("not json", false)).toThrow(/読み取れません/);
    expect(() => readCodexOutput('{"other":1}', true)).toThrow(/読み取れません/);
  });
});

describe("CHAT_TURNジョブでサブPCのCodex CLIへ投げる（#5067）", () => {
  it("ジョブを積み、サブPCが返した結果を読んで、Codex CLIの実行先として返す", async () => {
    state.onPoll = (jobId, run) => {
      const job = state.jobs.get(jobId);
      if (job && run && job.status === "QUEUED") {
        job.status = "RUNNING";
        run.stepResult = '{"text":"要約しました"}';
      }
    };
    const result = await runAppAiOnCodex({ feature: "comment_summary", model: "gpt-6-luna", body: summaryBody, sleep, clock });

    expect(result).toEqual({ text: "要約しました", model: "codex-cli/gpt-6-luna" });
    const job = state.jobs.get("job1");
    expect(job).toMatchObject({ kind: "CHAT_TURN", targetHost: "subpc", agent: "codex", codexModel: "gpt-6-luna" });
    // 結果を受け取ったら待ちの行は消す。Claude API・OpenAI APIには一度も送らない
    expect(state.deletedRuns).toEqual(["run1"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["not_logged_in", /ログインしていません/],
    ["usage_limit", /利用枠の上限/],
    ["api_key_auth", /APIキー/],
    ["bad_output", /読み取れません/],
  ])("サブPCが返した失敗 %s を区別して投げ、Claudeへは切り替えない", async (kind, message) => {
    state.onPoll = (_jobId, run) => {
      if (run) run.stepError = kind;
    };
    const promise = runAppAiOnCodex({ feature: "issue_search", model: "gpt-6-luna", body: summaryBody, sleep, clock });
    await expectKind(promise, kind);
    await expect(
      runAppAiOnCodex({ feature: "issue_search", model: "gpt-6-luna", body: summaryBody, sleep, clock }),
    ).rejects.toThrow(message);
    await expect(
      runAppAiOnCodex({ feature: "issue_search", model: "gpt-6-luna", body: summaryBody, sleep, clock }),
    ).rejects.toThrow("Claudeへは切り替えていません");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("受け取られたまま上限を過ぎたら、ジョブを取り消して timeout にする", async () => {
    state.onPoll = (jobId) => {
      const job = state.jobs.get(jobId);
      if (job?.status === "QUEUED") job.status = "RUNNING";
    };
    await expectKind(
      runAppAiOnCodex({ feature: "issue_body_cleanup", model: "gpt-6-luna", body: summaryBody, timeoutMs: 5_000, sleep, clock }),
      "timeout",
    );
    expect(state.jobs.get("job1")).toMatchObject({ status: "CANCELED", activeKey: null });
    expect(state.deletedRuns).toEqual(["run1"]);
  });

  it("サブPCが受け取らなければ not_claimed で取り消す", async () => {
    await expectKind(runAppAiOnCodex({ feature: "issue_suggest", model: "gpt-6-luna", body: summaryBody, sleep, clock }), "not_claimed");
    expect(state.jobs.get("job1")?.status).toBe("CANCELED");
  });

  it("サブPCがオフライン・pollerが未対応なら、ジョブを積まずに区別して断る", async () => {
    state.hosts = [{ name: "subpc", lastSeenAt: new Date(now - 60 * 60 * 1000), chatCodexCapable: true }];
    await expectKind(runAppAiOnCodex({ feature: "comment_summary", model: "gpt-6-luna", body: summaryBody, sleep, clock }), "offline");
    state.hosts = [{ name: "subpc", lastSeenAt: new Date(now), chatCodexCapable: false }];
    await expectKind(
      runAppAiOnCodex({ feature: "comment_summary", model: "gpt-6-luna", body: summaryBody, sleep, clock }),
      "unsupported_host",
    );
    expect(state.jobs.size).toBe(0);
  });

  it("画像付きの依頼は、実行中だけ画像をメモリに持ち、終われば消す（#5068）", async () => {
    let seen: unknown = null;
    state.onPoll = (jobId, run) => {
      const job = state.jobs.get(jobId);
      if (job && run && job.status === "QUEUED") {
        job.status = "RUNNING";
        seen = findAppAiCodexImages(run.id);
        run.stepResult = JSON.stringify({ text: '{"items":["「保存」を削除する（×印）"],"unreadable":false}' });
      }
    };
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "text", text: "読んで" },
          ],
        },
      ],
    };
    const result = await runAppAiOnCodex({ feature: "issue_image_extract", model: "gpt-6-luna", body, sleep, clock });
    expect(result.model).toBe("codex-cli/gpt-6-luna");
    expect(seen).toEqual([{ mediaType: "image/png", data: "AAAA" }]);
    expect(findAppAiCodexImages("run1")).toBeNull();
    expect(state.deletedRuns).toEqual(["run1"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("古いサブPCが画像付きの依頼を断られたら、チェックアウトの更新を促して止まる（#5068）", async () => {
    state.onPoll = (_jobId, run) => {
      if (run) run.stepError = "image_host_outdated";
    };
    const promise = runAppAiOnCodex({ feature: "issue_image_extract", model: "gpt-6-luna", body: summaryBody, sleep, clock });
    await expect(promise).rejects.toThrow(/サブPCのチェックアウトを更新してください.*Claudeへは切り替えていません/);
  });

  it("文書入力・モデル自動選択はジョブを積まずに対応外として断る", async () => {
    await expectKind(
      runAppAiOnCodex({
        feature: "issue_image_extract",
        model: "gpt-6-luna",
        body: { messages: [{ role: "user", content: [{ type: "document", source: {} }] }] },
        sleep,
        clock,
      }),
      "document_unsupported",
    );
    await expectKind(runAppAiOnCodex({ feature: "model_pick", model: "gpt-6-luna", body: summaryBody, sleep, clock }), "feature_unsupported");
    expect(state.jobs.size).toBe(0);
  });
});
