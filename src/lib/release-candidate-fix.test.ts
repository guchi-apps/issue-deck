import { beforeEach, describe, expect, it, vi } from "vitest";

const completionFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { releaseCompletionRun: { findMany: (...args: unknown[]) => completionFindMany(...args) } },
}));

import { loadReleaseCandidateCompletions } from "@/lib/release-candidate-fix";

const target = { repositoryFullName: "guchi-apps/asset-manager", number: 1592, headSha: "h1" };
const row = (overrides: Record<string, unknown> = {}) => ({
  repositoryFullName: target.repositoryFullName,
  candidatePrNumber: target.number,
  candidateHeadSha: "h1",
  status: "investigating",
  ...overrides,
});

describe("loadReleaseCandidateCompletions（#5614）", () => {
  beforeEach(() => completionFindMany.mockReset());

  it("候補の現在のheadを追う進行中の系列を、段階の文言つきで返す", async () => {
    completionFindMany.mockResolvedValue([row()]);
    const result = await loadReleaseCandidateCompletions([target]);
    expect(result.get("guchi-apps/asset-manager#1592")).toEqual({ status: "investigating", label: "原因を調査中" });
    // 公開承認から始めた系列・停止した系列は引かない
    expect(completionFindMany.mock.calls[0][0].where).toMatchObject({ activeKey: { not: null }, publishApprovalId: null, stoppedAt: null });
  });

  it("headが動いた候補・終わった系列は載せない", async () => {
    completionFindMany.mockResolvedValue([row({ candidateHeadSha: "h0" }), row({ status: "needs_attention" })]);
    expect((await loadReleaseCandidateCompletions([target])).size).toBe(0);
  });

  it("対象が無ければDBを引かない", async () => {
    expect((await loadReleaseCandidateCompletions([])).size).toBe(0);
    expect(completionFindMany).not.toHaveBeenCalled();
  });
});
