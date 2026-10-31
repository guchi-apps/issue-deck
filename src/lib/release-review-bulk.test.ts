import { describe, expect, it } from "vitest";

import {
  RELEASE_REVIEW_BULK_FALLBACK_REASON,
  buildBulkDecisionRows,
  countBulkDecisions,
  toBulkDecisionItem,
} from "@/lib/release-review-bulk";
import type { ReleaseReviewDecisionSummary } from "@/lib/release-review-decision";
import type { ReleaseReviewRecommendation } from "@/lib/release-review-recommendation";
import type { ReleaseReviewFinding } from "@/lib/release-review-result";

const finding = (id: string, severity: ReleaseReviewFinding["severity"] = "high"): ReleaseReviewFinding => ({
  id,
  severity,
  title: `指摘${id}`,
  detail: "",
  file: null,
  line: null,
  impact: null,
  evidence: null,
  recommendation: null,
  pullRequests: [],
});
const draft = (reason: string) => ({ reason, impact: null, scope: null, timing: null, followUpTitle: null });
const rec = (
  findingId: string,
  recommended: ReleaseReviewRecommendation["recommended"],
  overrides: Partial<ReleaseReviewRecommendation["drafts"]> = {},
): ReleaseReviewRecommendation => ({
  id: `rec-${findingId}`,
  findingId,
  baseSha: "a",
  headSha: "b",
  recommended,
  rationale: "根拠",
  drafts: {
    fix_now: draft("直す"),
    post_release: { ...draft("後で"), timing: "次のリリースまで", followUpTitle: "後で直す" },
    defer: { ...draft("見送る"), impact: "テスト時間のみ", scope: "テスト" },
    reject: draft("対象外"),
    ...overrides,
  },
  missing: [],
  createdAt: "2026-10-31T00:00:00Z",
});

const decided = (id: string, stale: string | null = null) =>
  ({
    byFinding: { [id]: { findingId: id, current: { id: "d1" }, stale, history: [{ id: "d1" }] } },
    detached: [],
    counts: { undecidedBlocking: 0, fixNow: 0, postRelease: 0, deferred: 0, rejected: 0, stale: 0 },
  }) as unknown as ReleaseReviewDecisionSummary;

describe("buildBulkDecisionRows", () => {
  it("止める指摘は推奨を初期値にし、推奨が無ければ安全側の「今回直す」にする", () => {
    const rows = buildBulkDecisionRows({
      findings: [finding("R-000001"), finding("R-000002")],
      suggestions: [],
      decisions: null,
      recommendations: { "R-000001": rec("R-000001", "post_release") },
    });
    expect(rows.map((r) => [r.findingId, r.decision, r.fallback])).toEqual([
      ["R-000001", "post_release", null],
      ["R-000002", "fix_now", "no_recommendation"],
    ]);
    expect(rows[1].options).toEqual(["fix_now"]);
  });

  it("推奨の必須項目が欠けていれば「今回直す」へ倒し、その判断は選べない", () => {
    const rows = buildBulkDecisionRows({
      findings: [finding("R-000001")],
      suggestions: [],
      decisions: null,
      recommendations: { "R-000001": rec("R-000001", "post_release", { post_release: { ...draft("後で"), timing: null, followUpTitle: "x" } }) },
    });
    expect(rows[0]).toMatchObject({ decision: "fix_now", fallback: "incomplete" });
    expect(rows[0].options).toEqual(["fix_now", "defer", "reject"]);
  });

  it("有効な判断がある指摘は除き、前提が変わった判断は対象に戻す", () => {
    const findings = [finding("R-000001")];
    expect(buildBulkDecisionRows({ findings, suggestions: [], decisions: decided("R-000001"), recommendations: {} })).toEqual([]);
    const rows = buildBulkDecisionRows({ findings, suggestions: [], decisions: decided("R-000001", "mainが進んだ"), recommendations: {} });
    expect(rows[0].expectedDecisionId).toBe("d1");
  });

  it("改善提案は推奨をそのまま使えるものだけ載せる（推奨が無ければ未判断のまま残す）", () => {
    const rows = buildBulkDecisionRows({
      findings: [],
      suggestions: [finding("R-000003", "low"), finding("R-000004", "low")],
      decisions: null,
      recommendations: { "R-000003": rec("R-000003", "defer") },
    });
    expect(rows.map((r) => [r.findingId, r.blocking, r.decision])).toEqual([["R-000003", false, "defer"]]);
  });
});

describe("toBulkDecisionItem", () => {
  it("推奨の理由案から送る値を作り、推奨が無い「今回直す」は固定文の安全側にする", () => {
    const [withRec, noRec] = buildBulkDecisionRows({
      findings: [finding("R-000001"), finding("R-000002")],
      suggestions: [],
      decisions: null,
      recommendations: { "R-000001": rec("R-000001", "post_release") },
    });
    expect(toBulkDecisionItem(withRec, "post_release")).toMatchObject({
      recommendationId: "rec-R-000001",
      decision: "post_release",
      timing: "次のリリースまで",
      followUp: { kind: "create", title: "後で直す" },
      fallback: false,
    });
    expect(toBulkDecisionItem(noRec, "fix_now")).toMatchObject({ recommendationId: null, reason: RELEASE_REVIEW_BULK_FALLBACK_REASON, fallback: true });
    expect(toBulkDecisionItem(noRec, "defer")).toBeNull();
  });
});

it("countBulkDecisions は判断ごとの件数を数える", () => {
  expect(countBulkDecisions(["fix_now", "fix_now", "defer"])).toEqual({ fix_now: 2, post_release: 0, defer: 1, reject: 0 });
});
