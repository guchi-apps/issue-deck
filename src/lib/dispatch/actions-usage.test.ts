import { describe, expect, it } from "vitest";

import { parseActionsUsagePayload, parseActionsUsageReport } from "@/lib/dispatch/actions-usage";

const report = (overrides: Record<string, unknown> = {}) => ({
  repository: "guchi-apps/issue-deck",
  runId: "12345",
  runUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/12345",
  workflowName: "Claude Issue Dispatch",
  issueNumber: 2615,
  stepName: "Claude Code（実装・PR作成）",
  responses: 4,
  inputTokens: 100,
  cacheCreateTokens: 200,
  cacheReadTokens: 300,
  outputTokens: 50,
  costUsd: 1.25,
  models: ["claude-opus-5"],
  startedAt: "2026-08-30T01:00:00.000Z",
  endedAt: "2026-08-30T02:00:00.000Z",
  ...overrides,
});

describe("GitHub ActionsのAI使用量報告", () => {
  it("数値と実行情報を受け取る", () => {
    expect(parseActionsUsageReport(report())).toMatchObject({
      repository: "guchi-apps/issue-deck",
      runId: "12345",
      issueNumber: 2615,
      cacheReadTokens: 300,
    });
  });

  it.each([
    ["リポジトリが無い", { repository: "" }],
    ["実行IDが無い", { runId: "" }],
    ["応答が0", { responses: 0 }],
    ["負のトークン", { outputTokens: -1 }],
    ["金額が文字列", { costUsd: "1.25" }],
    ["時刻が壊れている", { endedAt: "きのう" }],
  ])("%s場合は破棄する", (_label, overrides) => {
    expect(parseActionsUsageReport(report(overrides))).toBeNull();
  });

  it("1回の報告上限を超えた本文は受け付けない", () => {
    const reports = Array.from({ length: 21 }, (_unused, index) => report({ runId: String(index) }));
    expect(parseActionsUsagePayload({ reports })).toBeNull();
  });

  it("壊れた行を除き、読めた行だけを受け付ける", () => {
    const parsed = parseActionsUsagePayload({ reports: [report(), report({ responses: 0 })] });
    expect(parsed).toHaveLength(1);
  });
});
