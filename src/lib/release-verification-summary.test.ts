import { describe, expect, it } from "vitest";

import { summarizeReleaseVerification, type ReleaseVerificationDetailRow } from "./release-verification-summary";

const current = { baseSha: "b".repeat(40), headSha: "a".repeat(40) };
const row = (o: Partial<ReleaseVerificationDetailRow>): ReleaseVerificationDetailRow => ({
  kind: "ai_review",
  state: "passed",
  ...current,
  agent: "claude:opus",
  summary: null,
  findings: null,
  unverifiedScope: null,
  evidenceUrl: null,
  message: null,
  updatedAt: new Date("2026-10-10T00:00:00Z"),
  ...o,
});
const base = { current, enforced: false, aiReviewAssignee: "Claude Code · opus" };

describe("summarizeReleaseVerification", () => {
  it("記録が無ければ両方とも未実施でゲートはblocked", () => {
    const s = summarizeReleaseVerification({ ...base, rows: [] });
    expect(s.integration.state).toBe("not_run");
    expect(s.aiReview.state).toBe("not_run");
    expect(s.gateStatus).toBe("blocked");
  });

  it("全体レビューの指摘・影響PR・影響ファイルを返す", () => {
    const s = summarizeReleaseVerification({
      ...base,
      rows: [
        row({ kind: "integration" }),
        row({
          state: "needs_check",
          findings: { findings: [{ severity: "high", title: "退行", detail: "", file: "a.ts", pullRequests: [3] }], affectedPullRequests: [3], affectedFiles: ["a.ts"], reviewedFiles: 4, totalFiles: 4 },
        }),
      ],
    });
    expect(s.aiReview).toMatchObject({ state: "needs_check", agent: "claude:opus", affectedPullRequests: [3], affectedFiles: ["a.ts"] });
    expect(s.aiReview.findings).toHaveLength(1);
    expect(s.gateStatus).toBe("needs_confirmation");
  });

  it("未確認範囲つきのpassedは理由付きのneeds_checkになり、準備完了にならない", () => {
    const s = summarizeReleaseVerification({
      ...base,
      rows: [row({ kind: "integration" }), row({ unverifiedScope: "差分80ファイルのうち30" })],
    });
    expect(s.aiReview.state).toBe("needs_check");
    expect(s.aiReview.reason).toContain("差分80ファイル");
    expect(s.gateStatus).toBe("needs_confirmation");
  });

  it("SHAが変わった古い結果は無効", () => {
    const s = summarizeReleaseVerification({ ...base, rows: [row({ headSha: "c".repeat(40) })] });
    expect(s.aiReview.state).toBe("invalidated");
  });

  it("両方passedなら準備完了。AIのLGTMでも自動マージはしない（強制フラグは別）", () => {
    const s = summarizeReleaseVerification({ ...base, rows: [row({ kind: "integration" }), row({})] });
    expect(s.gateStatus).toBe("ready");
    expect(s.enforced).toBe(false);
  });
});
