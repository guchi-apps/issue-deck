import { describe, expect, it } from "vitest";

import { summarizeAgentReviews } from "./pr-review-agent-summary";

const row = (over: Partial<Parameters<typeof summarizeAgentReviews>[0][number]>) => ({
  agent: "codex",
  status: "SUCCEEDED" as const,
  reviewVerdict: "lgtm",
  message: null,
  claimedByHost: null,
  targetHost: "subpc",
  createdAt: new Date("2026-10-05T00:00:00Z"),
  ...over,
});

describe("summarizeAgentReviews", () => {
  it("agentごとの最新だけを状態にし、取り消しは使わない", () => {
    expect(summarizeAgentReviews([row({})])).toEqual([{ agent: "codex", state: "lgtm" }]);
    expect(
      summarizeAgentReviews([
        row({ status: "FAILED", createdAt: new Date("2026-10-05T00:00:00Z") }),
        row({ status: "RUNNING", reviewVerdict: null, createdAt: new Date("2026-10-05T01:00:00Z") }),
      ]),
    ).toEqual([{ agent: "codex", state: "pending" }]);
    expect(summarizeAgentReviews([row({ status: "CANCELED" })])).toEqual([]);
  });

  it("判定が読めない成功は失敗として扱う", () => {
    expect(summarizeAgentReviews([row({ reviewVerdict: null })])).toEqual([{ agent: "codex", state: "failed" }]);
  });
});
