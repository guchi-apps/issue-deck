import { beforeEach, describe, expect, it, vi } from "vitest";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = new Date("2026-10-10T12:00:00Z");

const hostFindMany = vi.fn();
const jobFindFirst = vi.fn();
const jobCreate = vi.fn();
const jobUpdateMany = vi.fn();
const verificationUpdateMany = vi.fn();
const settingFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    dispatchHost: { findMany: hostFindMany },
    dispatchJob: { findFirst: jobFindFirst, create: jobCreate, updateMany: jobUpdateMany },
    releaseVerification: { updateMany: verificationUpdateMany },
    appSetting: { findUnique: settingFindUnique },
  },
}));
vi.mock("@/lib/dispatch/jobs", () => ({ expireStaleDispatchJobs: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/dispatch/wake-notify", () => ({ notifyDispatchHostWake: vi.fn() }));

const { applyReleaseReviewReport, buildReleaseReviewActiveKey, requestReleaseReviewJob } = await import(
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

  it("skippedは何も書かない", async () => {
    expect(await applyReleaseReviewReport(job, "skipped", null, null)).toBe(false);
  });
});
