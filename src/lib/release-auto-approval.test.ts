import { describe, expect, it } from "vitest";

import { buildAutoApprovalRequestKey, decideAutoApproval, parseReviewAgentFamily } from "@/lib/release-auto-approval";
import { parseRcRequestKey } from "@/lib/release-rc";

const base = {
  enabled: true,
  phase: "review",
  contract: { requiresAiReviewWaiver: false },
  reviewAgent: "codex:gpt-6-sol",
  labels: [] as string[],
};

describe("decideAutoApproval", () => {
  it("別系統の全体レビューが合格していれば承認する", () => {
    expect(decideAutoApproval(base)).toEqual({ approve: true });
  });

  it("設定がOFFなら承認しない", () => {
    expect(decideAutoApproval({ ...base, enabled: false })).toEqual({ approve: false, wait: "disabled" });
  });

  it("review段階でなければ承認しない", () => {
    expect(decideAutoApproval({ ...base, phase: "preparing" })).toEqual({ approve: false, wait: "not_review_phase" });
  });

  it("契約が無ければ承認しない", () => {
    expect(decideAutoApproval({ ...base, contract: null })).toEqual({ approve: false, wait: "not_ready" });
  });

  it("全体レビューが合格していない（承知で進む明示が要る）候補は自動承認しない", () => {
    expect(decideAutoApproval({ ...base, contract: { requiresAiReviewWaiver: true } })).toEqual({ approve: false, wait: "review_waiver_required" });
  });

  it("全体レビューがClaudeなら独立した検証とみなさない", () => {
    expect(decideAutoApproval({ ...base, reviewAgent: "claude:opus" })).toEqual({ approve: false, wait: "review_not_independent" });
  });

  it("担当が分からなければ承認しない", () => {
    expect(decideAutoApproval({ ...base, reviewAgent: null })).toEqual({ approve: false, wait: "review_agent_unknown" });
    expect(decideAutoApproval({ ...base, reviewAgent: "" })).toEqual({ approve: false, wait: "review_agent_unknown" });
  });

  it("人の確認ラベルがあれば承認しない", () => {
    for (const label of ["22.merge-confirm-required", "00.check-user"]) {
      expect(decideAutoApproval({ ...base, labels: [label] })).toEqual({ approve: false, wait: "human_check_label" });
    }
  });
});

describe("parseReviewAgentFamily", () => {
  it("記録された担当から系統を読む", () => {
    expect(parseReviewAgentFamily("claude:opus")).toBe("claude");
    expect(parseReviewAgentFamily("Codex:gpt-6-sol")).toBe("codex");
    expect(parseReviewAgentFamily("codex")).toBe("codex");
  });
});

describe("buildAutoApprovalRequestKey", () => {
  it("要求キーの形式を満たし、同じ入力なら同じ値になる", () => {
    const key = buildAutoApprovalRequestKey("cmabc123def456ghi789jkl", "0123456789abcdef0123");
    expect(parseRcRequestKey(key)).toBe(key);
    expect(buildAutoApprovalRequestKey("cmabc123def456ghi789jkl", "0123456789abcdef0123")).toBe(key);
    expect(buildAutoApprovalRequestKey("cmabc123def456ghi789jkl", "ffffffffffffffff0123")).not.toBe(key);
  });
});
