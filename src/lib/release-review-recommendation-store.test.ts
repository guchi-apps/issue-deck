import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const upsert = vi.fn();
const findUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    releaseReviewRecommendation: {
      findMany: (...a: unknown[]) => findMany(...a),
      upsert: (...a: unknown[]) => upsert(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
      findUniqueOrThrow: vi.fn(),
    },
  },
}));

import { findUsableRecommendation, loadOrGenerateRecommendations } from "@/lib/release-review-recommendation-store";
import type { RecommendationTarget } from "@/lib/release-review-recommendation";

const key = { scopeKey: "o/r#10", baseSha: "base", headSha: "head" };
const draft = (reason: string) => ({ reason, impact: "影響", scope: "範囲", timing: "公開直後", followUpTitle: "題" });
const drafts = { fix_now: draft("直す"), post_release: draft("後で"), defer: draft("見送る"), reject: draft("対象外") };
const target = (id: string, over: Partial<RecommendationTarget> = {}): RecommendationTarget => ({
  id,
  title: id,
  detail: "",
  severity: "high",
  file: null,
  line: null,
  impact: null,
  evidence: null,
  recommendation: null,
  pullRequests: [],
  blocking: true,
  ...over,
});
const row = (findingId: string, over: Record<string, unknown> = {}) => ({
  id: `row-${findingId}`,
  ...key,
  findingId,
  severity: "high",
  blocking: true,
  status: "ready",
  recommended: "fix_now",
  rationale: "根拠",
  drafts,
  missing: [],
  error: null,
  createdAt: new Date("2026-10-17T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => row(create.findingId as string, { ...create, id: `new-${create.findingId}` }));
});

const generated = (ids: string[]) => ({
  model: "m",
  byFinding: new Map(ids.map((id) => [id, { recommended: "defer" as const, rationale: "根拠", drafts, missing: [] }])),
});

describe("loadOrGenerateRecommendations", () => {
  it("保存済みの推奨はAIを呼ばずに返し、無い指摘だけ作る", async () => {
    findMany.mockResolvedValue([row("R-1")]);
    const generate = vi.fn(async (batch: RecommendationTarget[]) => generated(batch.map((t) => t.id)));
    const view = await loadOrGenerateRecommendations({ key, repoFullName: "o/r", prNumber: 11, targets: [target("R-1"), target("R-2")], retry: false, generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].map((t: RecommendationTarget) => t.id)).toEqual(["R-2"]);
    expect(view.byFinding["R-1"].id).toBe("row-R-1");
    expect(view.byFinding["R-2"].recommended).toBe("defer");
  });

  it("原判定（重大度・止めるか）が変わった指摘は作り直す", async () => {
    findMany.mockResolvedValue([row("R-1", { severity: "medium" })]);
    const generate = vi.fn(async (batch: RecommendationTarget[]) => generated(batch.map((t) => t.id)));
    await loadOrGenerateRecommendations({ key, repoFullName: "o/r", prNumber: 11, targets: [target("R-1")], retry: false, generate });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("失敗は記録して返し、再取得を押したときだけ作り直す", async () => {
    findMany.mockResolvedValue([row("R-1", { status: "failed", recommended: null, error: "時間切れ" })]);
    const generate = vi.fn(async (batch: RecommendationTarget[]) => generated(batch.map((t) => t.id)));
    const view = await loadOrGenerateRecommendations({ key, repoFullName: "o/r", prNumber: 11, targets: [target("R-1")], retry: false, generate });
    expect(generate).not.toHaveBeenCalled();
    expect(view.failures["R-1"]).toBe("時間切れ");
    await loadOrGenerateRecommendations({ key, repoFullName: "o/r", prNumber: 11, targets: [target("R-1")], retry: true, generate });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("AIが失敗したら束の指摘を失敗として保存し、推奨にしない", async () => {
    const generate = vi.fn(async () => {
      throw new Error("AIの推奨を作れませんでした (529)");
    });
    const view = await loadOrGenerateRecommendations({ key, repoFullName: "o/r", prNumber: 11, targets: [target("R-1")], retry: false, generate });
    expect(view.byFinding).toEqual({});
    expect(view.failures["R-1"]).toContain("529");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ status: "failed", findingId: "R-1" }) }));
  });

  it("AIの認証情報が無ければ作らず、手動で判断できる旨を返す", async () => {
    const view = await loadOrGenerateRecommendations({ key, repoFullName: "o/r", prNumber: 11, targets: [target("R-1")], retry: false, generate: null });
    expect(view.status).toBe("unavailable");
    expect(view.failures["R-1"]).toBeTruthy();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("findUsableRecommendation", () => {
  it("別の対象・別の指摘の推奨は使わない", async () => {
    findUnique.mockResolvedValue(row("R-1"));
    expect(await findUsableRecommendation("row-R-1", { ...key, findingId: "R-1" })).not.toBeNull();
    expect(await findUsableRecommendation("row-R-1", { ...key, headSha: "new", findingId: "R-1" })).toBeNull();
    expect(await findUsableRecommendation("row-R-1", { ...key, findingId: "R-2" })).toBeNull();
    findUnique.mockResolvedValue(row("R-1", { status: "failed" }));
    expect(await findUsableRecommendation("row-R-1", { ...key, findingId: "R-1" })).toBeNull();
  });
});
