import { beforeEach, describe, expect, it, vi } from "vitest";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = new Date("2026-10-10T12:00:00Z");

const hostFindMany = vi.fn();
const jobFindFirst = vi.fn();
const jobCreate = vi.fn();
const jobUpdateMany = vi.fn();
const verificationUpdateMany = vi.fn();
const verificationFindFirst = vi.fn();
const settingFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    dispatchHost: { findMany: hostFindMany },
    dispatchJob: { findFirst: jobFindFirst, create: jobCreate, updateMany: jobUpdateMany },
    releaseVerification: { updateMany: verificationUpdateMany, findFirst: verificationFindFirst },
    appSetting: { findUnique: settingFindUnique },
  },
}));
vi.mock("@/lib/dispatch/jobs", () => ({ expireStaleDispatchJobs: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/dispatch/wake-notify", () => ({ notifyDispatchHostWake: vi.fn() }));

const { applyReleaseReviewReport, buildReleaseReviewActiveKey, requestReleaseReviewJob, rerunReleaseReviewJob } = await import(
  "./release-review-jobs"
);

const target = { repoFullName: "guchi-apps/issue-deck", prNumber: 9, baseSha: BASE, headSha: HEAD };
const host = (overrides = {}) => ({
  name: "subpc",
  lastSeenAt: NOW,
  releaseReviewCapable: true,
  codexCapable: true,
  repositories: JSON.stringify(["guchi-apps/issue-deck"]),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  verificationUpdateMany.mockResolvedValue({ count: 1 });
  verificationFindFirst.mockResolvedValue(null);
  jobFindFirst.mockResolvedValue(null);
  jobUpdateMany.mockResolvedValue({ count: 0 });
  settingFindUnique.mockResolvedValue({ appAiModelReasoning: "claude-opus-5-5", aiExecutionProvider: "claude" });
});

describe("requestReleaseReviewJob", () => {
  it("設定の担当（opus）で積み、古い待機中ジョブを取り消す", async () => {
    hostFindMany.mockResolvedValue([host()]);
    jobCreate.mockResolvedValue({ id: "j1", targetHost: "subpc" });
    const result = await requestReleaseReviewJob(target, NOW);
    expect(result).toMatchObject({ ok: true, outcome: "queued" });
    expect(jobCreate.mock.calls[0][0].data).toMatchObject({
      kind: "RELEASE_REVIEW",
      agent: "claude",
      claudeModel: "opus",
      activeKey: buildReleaseReviewActiveKey(target),
      issueNumber: 9,
    });
    expect(jobUpdateMany.mock.calls[0][0].data.status).toBe("CANCELED");
  });

  it("担当がCodexなら、Codex未対応のホストには積まない", async () => {
    settingFindUnique.mockResolvedValue({ appAiModelReasoning: "gpt-6-sol" });
    hostFindMany.mockResolvedValue([host({ codexCapable: false })]);
    const result = await requestReleaseReviewJob(target, NOW);
    expect(result).toMatchObject({ ok: false, rejection: "no_host" });
    expect(verificationUpdateMany.mock.calls[0][0]).toMatchObject({ data: { state: "failed" } });
  });

  it("対応ホストが無ければai_reviewをfailedで記録する", async () => {
    hostFindMany.mockResolvedValue([host({ releaseReviewCapable: null })]);
    await requestReleaseReviewJob(target, NOW);
    expect(verificationUpdateMany.mock.calls[0][0].where).toMatchObject({ kind: "ai_review" });
  });

  it("自動再評価（#4664）: 指定したホストにだけ積む", async () => {
    hostFindMany.mockResolvedValue([host({ name: "a-host" }), host({ name: "verify-host" })]);
    jobCreate.mockImplementation(({ data }) => Promise.resolve({ id: "j1", ...data }));
    const result = await requestReleaseReviewJob(target, NOW, { requiredHost: "verify-host", recordNoHost: false });
    expect(result).toMatchObject({ ok: true, outcome: "queued" });
    expect(jobCreate.mock.calls[0][0].data.targetHost).toBe("verify-host");
  });

  it("自動再評価（#4664）: 指定ホストが不適格なら、有効な結果を失敗で上書きせずに見送る", async () => {
    hostFindMany.mockResolvedValue([host({ name: "a-host" }), host({ name: "verify-host", releaseReviewCapable: false })]);
    const result = await requestReleaseReviewJob(target, NOW, { requiredHost: "verify-host", recordNoHost: false });
    expect(result).toMatchObject({ ok: false, rejection: "no_host" });
    expect(jobCreate).not.toHaveBeenCalled();
    expect(verificationUpdateMany).not.toHaveBeenCalled();
  });

  it("同じ対象の未完了ジョブがあれば積まない", async () => {
    jobFindFirst.mockResolvedValue({ id: "j0" });
    expect(await requestReleaseReviewJob(target, NOW)).toMatchObject({ outcome: "already_queued" });
    expect(jobCreate).not.toHaveBeenCalled();
  });
});

describe("applyReleaseReviewReport", () => {
  const job = { repositoryFullName: target.repoFullName, prNumber: 9, baseSha: BASE, headSha: HEAD, agent: "claude", claudeModel: "opus" };

  it("指摘ありはneeds_checkで、担当AIと対象SHAを残す", async () => {
    await applyReleaseReviewReport(job, "succeeded", null, {
      state: "passed",
      findings: [{ title: "退行", severity: "high" }],
    });
    const arg = verificationUpdateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ ...target, kind: "ai_review" });
    expect(arg.data).toMatchObject({ state: "needs_check", agent: "claude:opus" });
    expect(arg.data.findings).toMatchObject({ targetHeadSha: HEAD, targetBaseSha: BASE });
  });

  it("結果の無い成功はfailed", async () => {
    await applyReleaseReviewReport(job, "succeeded", null, undefined);
    expect(verificationUpdateMany.mock.calls[0][0].data.state).toBe("failed");
  });

  it("失敗の診断は対象SHA付きで残し、報告の本文のSHAは使わない（#4300）", async () => {
    await applyReleaseReviewReport(job, "failed", "全体レビューを完走できませんでした", {
      diagnostic: { cause: "timeout", stage: "review", exitCode: 124, excerpt: "Bearer abcdef1234567890", targetHeadSha: "x" },
    });
    const data = verificationUpdateMany.mock.calls[0][0].data;
    expect(data.state).toBe("failed");
    expect(data.findings.diagnostic).toMatchObject({ cause: "timeout", targetHeadSha: HEAD, targetBaseSha: BASE });
    expect(data.findings.diagnostic.excerpt).not.toContain("abcdef1234567890");
  });

  it("診断の無い失敗（古い実行側）は旧診断を持ち越さず、指摘も残さない", async () => {
    await applyReleaseReviewReport(job, "failed", "失敗", undefined);
    const data = verificationUpdateMany.mock.calls[0][0].data;
    expect(data.state).toBe("failed");
    expect(JSON.stringify(data.findings)).not.toContain("targetHeadSha");
  });

  it("結果を記録するとき、再実行で退避したpreviousRunを引き継ぐ（#4632）", async () => {
    const previousRun = { state: "needs_check", at: "2026-10-13T09:00:00.000Z", unverifiedScope: "x", summary: null };
    verificationFindFirst.mockResolvedValue({ findings: { previousRun } });
    await applyReleaseReviewReport(job, "failed", "失敗", { diagnostic: { cause: "unknown" } });
    expect(verificationUpdateMany.mock.calls[0][0].data.findings).toMatchObject({ previousRun });
  });

  it("自動再評価の印（#4664）も結果へ引き継ぎ、同じ証跡で繰り返さない", async () => {
    const autoReevaluation = { integrationAt: "2026-10-16T05:25:00.000Z", requestedAt: "2026-10-16T05:25:10.000Z" };
    verificationFindFirst.mockResolvedValue({ findings: { autoReevaluation } });
    await applyReleaseReviewReport(job, "succeeded", null, { state: "passed", findings: [] });
    expect(verificationUpdateMany.mock.calls[0][0].data.findings).toMatchObject({ autoReevaluation });
  });

  it("skippedは何も書かない", async () => {
    expect(await applyReleaseReviewReport(job, "skipped", null, null)).toBe(false);
  });
});

describe("rerunReleaseReviewJob", () => {
  it("積めたときだけai_reviewをwaitingへ戻し、旧診断・指摘を消す", async () => {
    hostFindMany.mockResolvedValue([host()]);
    jobCreate.mockResolvedValue({ id: "j2", targetHost: "subpc" });
    const result = await rerunReleaseReviewJob(target, NOW);
    expect(result).toMatchObject({ ok: true, outcome: "queued" });
    const arg = verificationUpdateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ ...target, kind: "ai_review" });
    expect(arg.data).toMatchObject({ state: "waiting", message: null, summary: null, unverifiedScope: null });
  });

  it("旧結果は新テーブルを作らず、findingsのpreviousRunへ直前1件だけ退避する（#4632）", async () => {
    hostFindMany.mockResolvedValue([host()]);
    jobCreate.mockResolvedValue({ id: "j2", targetHost: "subpc" });
    verificationFindFirst.mockResolvedValue({
      state: "needs_check",
      summary: "旧要約",
      unverifiedScope: "統合検証の結果待ち",
      updatedAt: new Date("2026-10-13T09:00:00Z"),
    });
    await rerunReleaseReviewJob(target, NOW);
    expect(verificationUpdateMany.mock.calls[0][0].data.findings).toEqual({
      previousRun: {
        state: "needs_check",
        at: "2026-10-13T09:00:00.000Z",
        unverifiedScope: "統合検証の結果待ち",
        summary: "旧要約",
      },
    });
  });

  it("自動再評価（#4664）は印を残して積む", async () => {
    hostFindMany.mockResolvedValue([host()]);
    jobCreate.mockResolvedValue({ id: "j2", targetHost: "subpc" });
    const autoReevaluation = { integrationAt: "2026-10-16T05:25:00.000Z", requestedAt: "2026-10-16T05:25:10.000Z" };
    await rerunReleaseReviewJob(target, NOW, { requiredHost: "subpc", recordNoHost: false, autoReevaluation });
    expect(verificationUpdateMany.mock.calls[0][0].data.findings).toEqual({ autoReevaluation });
  });

  it("実行中・待機中のジョブがあれば二重に積まず、記録も戻さない", async () => {
    jobFindFirst.mockResolvedValue({ id: "j0" });
    expect(await rerunReleaseReviewJob(target, NOW)).toMatchObject({ outcome: "already_queued" });
    expect(jobCreate).not.toHaveBeenCalled();
    expect(verificationUpdateMany).not.toHaveBeenCalled();
  });
});
