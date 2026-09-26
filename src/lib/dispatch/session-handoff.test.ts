import { describe, expect, it } from "vitest";

import {
  describeHandoffComment,
  pickHandoffInitialAgent,
  summarizeAgentQuota,
  type QuotaWindow,
} from "@/lib/dispatch/session-handoff";

const window = (overrides: Partial<QuotaWindow> = {}): QuotaWindow => ({
  label: "5時間",
  usedPercent: 40,
  remainingPercent: 60,
  resetsAt: 1_000,
  status: "allowed",
  ...overrides,
});

describe("pickHandoffInitialAgent", () => {
  it("元と逆のエージェントを返す", () => {
    expect(pickHandoffInitialAgent("claude")).toBe("codex");
    expect(pickHandoffInitialAgent("codex")).toBe("claude");
  });
});

describe("summarizeAgentQuota", () => {
  it("取得できていなければ使い切りとみなさない", () => {
    expect(summarizeAgentQuota(null)).toEqual({ exhausted: false, hint: null, resetsAt: null });
    expect(summarizeAgentQuota([])).toEqual({ exhausted: false, hint: null, resetsAt: null });
  });

  it("使用率の最も高い枠を補足として出す", () => {
    const summary = summarizeAgentQuota([
      window({ label: "5時間", usedPercent: 12.4 }),
      window({ label: "週間", usedPercent: 71 }),
    ]);
    expect(summary).toEqual({ exhausted: false, hint: "週間枠 71%使用", resetsAt: null });
  });

  it("statusがrejectedか残り0%なら使い切りで、戻る時刻は最も遅い枠のもの", () => {
    const summary = summarizeAgentQuota([
      window({ label: "5時間", remainingPercent: 0, usedPercent: 100, resetsAt: 500 }),
      window({ label: "週間", status: "rejected", resetsAt: 9_000 }),
    ]);
    expect(summary.exhausted).toBe(true);
    expect(summary.hint).toBe("5時間枠を使い切り");
    expect(summary.resetsAt).toBe(9_000);
  });

  it("リセット後で使用量が分からない枠（expired）は判定に使わない", () => {
    const summary = summarizeAgentQuota([
      window({ remainingPercent: 0, usedPercent: 100, expired: true }),
    ]);
    expect(summary).toEqual({ exhausted: false, hint: null, resetsAt: null });
  });
});

describe("describeHandoffComment", () => {
  it("引き継ぎ元・先・モデルと、転記の添付有無を書く", () => {
    const body = describeHandoffComment({
      from: "claude",
      to: "codex",
      modelLabel: "Terra",
      includeTranscript: true,
    });
    expect(body).toContain("Claude Code → Codex CLI（Terra）");
    expect(body).toContain("転記（全文）も添えています");
  });

  it("モデル名が無ければ括弧を付けない", () => {
    const body = describeHandoffComment({ from: "codex", to: "claude", includeTranscript: false });
    expect(body).toContain("Codex CLI → Claude Code\n");
    expect(body).toContain("添えていません");
  });
});
