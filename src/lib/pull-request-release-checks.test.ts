import { beforeEach, describe, expect, it, vi } from "vitest";

const releaseVerificationFindMany = vi.fn();
const dispatchJobFindMany = vi.fn();
const finalizationFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    releaseVerification: { findMany: (...args: unknown[]) => releaseVerificationFindMany(...args) },
    dispatchJob: { findMany: (...args: unknown[]) => dispatchJobFindMany(...args) },
    releaseCandidateFinalization: { findMany: (...args: unknown[]) => finalizationFindMany(...args) },
  },
}));

import { expectedRerunKinds, fetchReleaseChecks, summarizeReleaseChecks } from "@/lib/pull-request-release-checks";

const current = { baseSha: "b1", headSha: "h1" };

describe("summarizeReleaseChecks", () => {
  it("記録が無ければ両方とも未実施になる", () => {
    expect(summarizeReleaseChecks(current, [])).toEqual({ aiReview: "not_run", integration: "not_run" });
  });

  it("現在のSHAの結果を区分ごとに返し、待機中は実行中へ畳む", () => {
    expect(
      summarizeReleaseChecks(current, [
        { kind: "ai_review", state: "passed", baseSha: "b1", headSha: "h1" },
        { kind: "integration", state: "waiting", baseSha: "b1", headSha: "h1" },
      ]),
    ).toEqual({ aiReview: "passed", integration: "running" });
  });

  it("対象が変わった古い結果は無効扱いにし、成功と見せない", () => {
    expect(
      summarizeReleaseChecks(current, [{ kind: "integration", state: "passed", baseSha: "b0", headSha: "h0" }]),
    ).toEqual({ aiReview: "not_run", integration: "invalidated" });
  });
});

describe("fetchReleaseChecks（#4390）", () => {
  // 強制していないリポジトリ（#4365の台帳でenforced: false）
  const target = {
    repositoryFullName: "guchi-apps/morrow",
    number: 554,
    baseRef: "main",
    headRef: "release-main/v3.15.5",
    baseSha: "b1",
    headSha: "h1",
  };
  const key = "guchi-apps/morrow#554";
  const row = (kind: string, state: string, headSha = "h1") => ({
    repoFullName: target.repositoryFullName,
    prNumber: 554,
    kind,
    state,
    baseSha: "b1",
    headSha,
    unverifiedScope: null,
  });

  beforeEach(() => {
    releaseVerificationFindMany.mockReset().mockResolvedValue([]);
    dispatchJobFindMany.mockReset().mockResolvedValue([]);
    finalizationFindMany.mockReset().mockResolvedValue([]);
  });

  it("強制していないリポジトリのリリースPRにも返し、実行中のジョブで待機中と実行中を分ける", async () => {
    releaseVerificationFindMany.mockResolvedValue([row("ai_review", "waiting"), row("integration", "waiting")]);
    dispatchJobFindMany.mockResolvedValue([
      { kind: "RELEASE_REVIEW", repositoryFullName: target.repositoryFullName, prNumber: 554, baseSha: "b1", headSha: "h1", progress: null },
      // 作り直す前のSHAのジョブは現在の候補の進行に数えない
      { kind: "RELEASE_VERIFY", repositoryFullName: target.repositoryFullName, prNumber: 554, baseSha: "b1", headSha: "old", progress: null },
    ]);

    const checks = (await fetchReleaseChecks([target])).get(key);

    expect(checks).toMatchObject({
      aiReview: "running",
      integration: "running",
      enforced: false,
      started: { aiReview: true, integration: false, mac: false },
    });
  });

  it("候補のSHAが変わったら古い成功を流用せず、対象変更で無効とする", async () => {
    releaseVerificationFindMany.mockResolvedValue([row("ai_review", "passed", "old"), row("integration", "passed", "old")]);

    const checks = (await fetchReleaseChecks([target])).get(key);

    expect(checks).toMatchObject({ aiReview: "invalidated", integration: "invalidated" });
    expect(checks?.rerun).toEqual({ aiReview: false, integration: false });
  });

  it("古い結果でも、現在の対象の待機中ジョブがあれば再実行が見込めると返す（#4862）", async () => {
    releaseVerificationFindMany.mockResolvedValue([row("integration", "passed", "old")]);
    dispatchJobFindMany.mockResolvedValue([
      { kind: "RELEASE_VERIFY", repositoryFullName: target.repositoryFullName, prNumber: 554, baseSha: "b1", headSha: "h1", progress: null },
    ]);

    const checks = (await fetchReleaseChecks([target])).get(key);

    expect(checks).toMatchObject({ integration: "invalidated", rerun: { integration: true } });
  });

  it("記録を読めない・基準SHAが無いときは取得不能を返す（成功と推測しない）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    releaseVerificationFindMany.mockRejectedValue(new Error("db down"));
    expect((await fetchReleaseChecks([target])).get(key)?.unavailable).toBe(true);
    expect((await fetchReleaseChecks([{ ...target, baseSha: null }])).get(key)?.unavailable).toBe(true);
  });

  it("リリース候補でないPRには何も返さない", async () => {
    expect((await fetchReleaseChecks([{ ...target, headRef: "develop" }])).size).toBe(0);
  });
});

describe("expectedRerunKinds（#4862）", () => {
  const now = new Date("2026-10-19T12:40:00Z");
  const rerunEvidence = [
    { kind: "integration", action: "rerun", reason: "r", fromBaseSha: "b1", fromHeadSha: "h0", toBaseSha: "b1", toHeadSha: "h1", files: [] },
  ];
  const applied = (updatedAt: string) => ({
    status: "applied",
    finalHeadSha: "h1",
    handoffEvidence: rerunEvidence,
    updatedAt: new Date(updatedAt),
  });

  it("現在の対象の未完了ジョブがある区分は再実行が見込める", () => {
    expect(expectedRerunKinds({ activeJobKinds: ["RELEASE_VERIFY"], finalizations: [], headSha: "h1", now })).toEqual({
      aiReview: false,
      integration: true,
    });
  });

  it("適用済みの公開準備が再実行と記録して間もなければ見込める", () => {
    const r = expectedRerunKinds({ activeJobKinds: [], finalizations: [applied("2026-10-19T12:33:00Z")], headSha: "h1", now });
    expect(r).toEqual({ aiReview: false, integration: true });
  });

  it("時間が過ぎた・先端が違う・引継ぎのみなら見込まない", () => {
    const old = applied("2026-10-19T11:00:00Z");
    expect(expectedRerunKinds({ activeJobKinds: [], finalizations: [old], headSha: "h1", now }).integration).toBe(false);
    const fresh = applied("2026-10-19T12:39:00Z");
    expect(expectedRerunKinds({ activeJobKinds: [], finalizations: [fresh], headSha: "h2", now }).integration).toBe(false);
    const inherit = { ...fresh, handoffEvidence: [{ ...rerunEvidence[0], action: "inherit" }] };
    expect(expectedRerunKinds({ activeJobKinds: [], finalizations: [inherit], headSha: "h1", now }).integration).toBe(false);
  });
});
