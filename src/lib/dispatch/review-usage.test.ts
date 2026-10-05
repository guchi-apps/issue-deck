import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
vi.mock("@/lib/db", () => ({ db: { sessionUsage: { upsert: (...args: unknown[]) => upsert(...args) } } }));

import {
  parseReviewUsagePayload,
  parseReviewUsageReport,
  reviewUsageSessionId,
  storeReviewUsage,
} from "@/lib/dispatch/review-usage";

/** サブPCのCodex PRレビューが送る報告（#3995） */
const report = (overrides: Record<string, unknown> = {}) => ({
  agent: "codex",
  process: "codex-pr-review",
  attemptId: "01a10ba3-e01b-7090-885f-6318ef55f9b8",
  repository: "guchi-apps/issue-deck",
  prNumber: 4010,
  issueNumber: 3995,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  status: "completed",
  usage: {
    responses: 1,
    inputTokens: 1915,
    cacheCreateTokens: 0,
    cacheReadTokens: 12288,
    outputTokens: 5,
    costUsd: 0.0063,
    inputCostUsd: 0.0062,
    outputCostUsd: 0.0001,
  },
  models: ["gpt-5.6-terra"],
  resultUrl: "https://github.com/guchi-apps/issue-deck/pull/4010#issuecomment-1",
  startedAt: "2026-10-05T01:00:00Z",
  endedAt: "2026-10-05T01:05:00Z",
  ...overrides,
});

describe("parseReviewUsageReport", () => {
  it("Codexの実行として、対象・試行・使用量を受け取る", () => {
    expect(parseReviewUsageReport(report())).toMatchObject({
      agent: "codex",
      prNumber: 4010,
      issueNumber: 3995,
      status: "completed",
      usage: { responses: 1, cacheReadTokens: 12288, costUsd: 0.0063 },
    });
  });

  it("使用量を取れなかった試行（タイムアウト）もnullのまま受け取る。0には置き換えない", () => {
    expect(parseReviewUsageReport(report({ status: "timeout", usage: null }))).toMatchObject({
      status: "timeout",
      usage: null,
    });
  });

  it("単価不明（金額null）は金額だけをnullにして受け取る", () => {
    const parsed = parseReviewUsageReport(
      report({ models: [], usage: { ...report().usage, costUsd: null, inputCostUsd: null, outputCostUsd: null } }),
    );
    expect(parsed?.usage).toMatchObject({ costUsd: null, inputCostUsd: null, outputCostUsd: null, outputTokens: 5 });
  });

  it.each([
    ["知らないエージェント", { agent: "gemini" }],
    ["agentが無い（Claudeとみなさない）", { agent: undefined }],
    ["PR番号が無い", { prNumber: null }],
    ["SHAが壊れている", { headSha: "not-a-sha" }],
    ["状態が不明", { status: "unknown" }],
    ["試行IDに空白", { attemptId: "a b" }],
    ["使用量の応答が0（記録なしはnullで送る）", { usage: { ...report().usage, responses: 0 } }],
    ["使用量が欠けている", { usage: undefined }],
  ])("%sなら破棄する", (_label, overrides) => {
    expect(parseReviewUsageReport(report(overrides))).toBeNull();
  });

  it("結果URLがhttpsでなければURLだけを捨てて行は残す（開けないだけで計上は正しい）", () => {
    expect(parseReviewUsageReport(report({ resultUrl: "javascript:alert(1)" }))?.resultUrl).toBeNull();
  });

  it("壊れた行だけを数えて捨てる", () => {
    expect(parseReviewUsagePayload({ reports: [report(), report({ agent: "x" })] })).toMatchObject({ skipped: 1 });
    expect(parseReviewUsagePayload({ reports: Array.from({ length: 21 }, () => report()) })).toBeNull();
  });
});

describe("reviewUsageSessionId", () => {
  it("同じ試行の再送は同じキー、再レビュー（別試行）は別のキーになる", () => {
    const first = parseReviewUsageReport(report())!;
    const resent = parseReviewUsageReport(report({ endedAt: "2026-10-05T01:06:00Z" }))!;
    const retried = parseReviewUsageReport(report({ attemptId: "second-attempt" }))!;
    expect(reviewUsageSessionId(resent)).toBe(reviewUsageSessionId(first));
    expect(reviewUsageSessionId(retried)).not.toBe(reviewUsageSessionId(first));
  });
});

describe("storeReviewUsage", () => {
  beforeEach(() => upsert.mockReset());

  it("処理種別はCI/CD・レビュー、実行場所はローカルのホスト、エージェントはCodexとして保存する", async () => {
    await storeReviewUsage({ hostName: "subpc", reports: [parseReviewUsageReport(report())!] });
    const call = upsert.mock.calls[0][0];
    expect(call.where.host_agent_sessionId).toMatchObject({ host: "subpc", agent: "codex" });
    expect(call.create).toMatchObject({
      host: "subpc",
      agent: "codex",
      source: "local",
      kind: "actions",
      repository: "issue-deck",
      issueNumber: 3995,
      prNumber: 4010,
      workflowName: "Codex PRレビュー",
      runUrl: "https://github.com/guchi-apps/issue-deck/pull/4010#issuecomment-1",
      responses: 1,
      models: JSON.stringify(["gpt-5.6-terra"]),
    });
    expect(call.update).toEqual(expect.objectContaining({ source: "local", kind: "actions" }));
  });

  it("使用量の無い試行は応答0の行として残し、失敗の種類を名前に出す", async () => {
    await storeReviewUsage({
      hostName: "subpc",
      reports: [parseReviewUsageReport(report({ status: "timeout", usage: null }))!],
    });
    expect(upsert.mock.calls[0][0].create).toMatchObject({
      responses: 0,
      inputTokens: BigInt(0),
      costUsd: 0,
      inputCostUsd: null,
      workflowName: "Codex PRレビュー（タイムアウト）",
    });
  });
});
