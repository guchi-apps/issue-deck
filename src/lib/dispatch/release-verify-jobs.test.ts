import { beforeEach, describe, expect, it, vi } from "vitest";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = new Date("2026-10-10T12:00:00Z");

const hostFindMany = vi.fn();
const jobFindFirst = vi.fn();
const jobCreate = vi.fn();
const jobUpdateMany = vi.fn();
const verificationUpdateMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    dispatchHost: { findMany: hostFindMany },
    dispatchJob: { findFirst: jobFindFirst, create: jobCreate, updateMany: jobUpdateMany },
    releaseVerification: { updateMany: verificationUpdateMany },
  },
}));
vi.mock("@/lib/dispatch/jobs", () => ({ expireStaleDispatchJobs: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/dispatch/wake-notify", () => ({ notifyDispatchHostWake: vi.fn() }));

const { RELEASE_VERIFICATION_REPOS } = await import("@/lib/release-verification-config");
const { applyReleaseVerifyReport, buildReleaseVerifyActiveKey, requestReleaseVerifyJob } = await import(
  "./release-verify-jobs"
);

const target = { repoFullName: "guchi-apps/issue-deck", prNumber: 9, baseSha: BASE, headSha: HEAD };
const host = (overrides = {}) => ({
  name: "subpc",
  lastSeenAt: NOW,
  releaseVerifyCapable: true,
  repositories: JSON.stringify(["guchi-apps/issue-deck"]),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  verificationUpdateMany.mockResolvedValue({ count: 1 });
  jobFindFirst.mockResolvedValue(null);
  jobUpdateMany.mockResolvedValue({ count: 0 });
});

describe("buildReleaseVerifyActiveKey", () => {
  it("リポジトリ・PR・base・head・種別を含む", () => {
    expect(buildReleaseVerifyActiveKey(target, "integration")).toBe(
      `release_verify:guchi-apps/issue-deck#9@${BASE}:${HEAD}:integration`,
    );
  });
});

describe("requestReleaseVerifyJob", () => {
  it("台帳に無いリポジトリは対象外にせず、設定不足としてfailedで記録する", async () => {
    const result = await requestReleaseVerifyJob({ ...target, repoFullName: "guchi-apps/other" }, NOW);
    expect(result).toMatchObject({ ok: false, rejection: "not_configured" });
    expect(jobCreate).not.toHaveBeenCalled();
    expect(verificationUpdateMany.mock.calls[0][0].data).toMatchObject({ state: "failed" });
  });

  it("前提が未整備のリポジトリはジョブを積まず、failedで理由を残す", async () => {
    const repo = "guchi-apps/gap-fixture";
    (RELEASE_VERIFICATION_REPOS as Record<string, unknown>)[repo] = {
      enforced: false,
      integrationCommands: ["npm ci"],
      setupGaps: ["テスト用の前提不足"],
    };
    try {
      const result = await requestReleaseVerifyJob({ ...target, repoFullName: repo }, NOW);
      expect(result).toMatchObject({ ok: false, rejection: "not_configured" });
      expect(jobCreate).not.toHaveBeenCalled();
      expect(verificationUpdateMany.mock.calls[0][0].data).toMatchObject({ state: "failed" });
    } finally {
      delete (RELEASE_VERIFICATION_REPOS as Record<string, unknown>)[repo];
    }
  });

  it("前提不足の無いasset-managerは静的に止まらず、検証ジョブを積める", async () => {
    hostFindMany.mockResolvedValue([host({ repositories: JSON.stringify(["guchi-apps/asset-manager"]) })]);
    jobCreate.mockResolvedValue({ id: "job1" });
    const result = await requestReleaseVerifyJob({ ...target, repoFullName: "guchi-apps/asset-manager" }, NOW);
    expect(result).not.toMatchObject({ rejection: "not_configured" });
    expect(jobCreate).toHaveBeenCalled();
  });

  it("根拠付きの対象外（アーカイブ等）だけがnot_applicableになる", async () => {
    const result = await requestReleaseVerifyJob({ ...target, repoFullName: "guchi-apps/trainroute" }, NOW);
    expect(result).toMatchObject({ ok: true, outcome: "not_applicable" });
    expect(jobCreate).not.toHaveBeenCalled();
    expect(verificationUpdateMany.mock.calls[0][0].data).toMatchObject({ state: "not_applicable" });
  });

  it("対応ホストへ積み、古い対象の待機中ジョブを取り消す", async () => {
    hostFindMany.mockResolvedValue([host()]);
    jobCreate.mockResolvedValue({ id: "j1", targetHost: "subpc" });
    const result = await requestReleaseVerifyJob(target, NOW);
    expect(result).toMatchObject({ ok: true, outcome: "queued" });
    expect(jobCreate.mock.calls[0][0].data).toMatchObject({
      kind: "RELEASE_VERIFY",
      prNumber: 9,
      baseSha: BASE,
      headSha: HEAD,
      issueNumber: 9,
    });
    expect(jobUpdateMany.mock.calls[0][0].data.status).toBe("CANCELED");
  });

  it("同じ対象の未完了ジョブがあれば積まない", async () => {
    jobFindFirst.mockResolvedValue({ id: "j0" });
    const result = await requestReleaseVerifyJob(target, NOW);
    expect(result).toMatchObject({ ok: true, outcome: "already_queued" });
    expect(jobCreate).not.toHaveBeenCalled();
  });

  it("対応ホストが無ければfailedで記録して断る", async () => {
    hostFindMany.mockResolvedValue([host({ releaseVerifyCapable: null })]);
    const result = await requestReleaseVerifyJob(target, NOW);
    expect(result).toMatchObject({ ok: false, rejection: "no_host" });
    expect(verificationUpdateMany.mock.calls[0][0].data).toMatchObject({ state: "failed" });
  });
});

describe("applyReleaseVerifyReport", () => {
  const job = { repositoryFullName: target.repoFullName, prNumber: 9, baseSha: BASE, headSha: HEAD };

  it("完走して結果が付いていればその状態を記録する", async () => {
    await applyReleaseVerifyReport(job, "succeeded", null, { state: "passed", summary: "ok", unverifiedScope: "Mac" });
    expect(verificationUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { ...target, kind: "integration" },
      data: { state: "passed", unverifiedScope: "Mac" },
    });
  });

  it("macの結果があれば統合検証とは別のkind=macの記録にし、統合検証の記録は変えない（#4366）", async () => {
    await applyReleaseVerifyReport(job, "succeeded", null, {
      state: "passed",
      summary: "ok",
      mac: { state: "needs_check", summary: "未接続", unverifiedScope: "Macへ接続できません" },
    });
    const calls = verificationUpdateMany.mock.calls.map(([arg]) => arg);
    expect(calls.map((c) => c.where.kind)).toEqual(["mac", "integration"]);
    expect(calls[0].data).toMatchObject({ state: "needs_check", unverifiedScope: "Macへ接続できません" });
    expect(calls[1].data).toMatchObject({ state: "passed" });
  });

  it("macを送らない旧版のランナーでは、macの記録を作らない", async () => {
    await applyReleaseVerifyReport(job, "succeeded", null, { state: "passed" });
    expect(verificationUpdateMany.mock.calls.map(([arg]) => arg.where.kind)).toEqual(["integration"]);
  });

  it("結果の無い成功はfailedにする", async () => {
    await applyReleaseVerifyReport(job, "succeeded", null, undefined);
    expect(verificationUpdateMany.mock.calls[0][0].data.state).toBe("failed");
  });

  it("失敗の報告はfailedで記録する", async () => {
    await applyReleaseVerifyReport(job, "failed", "落ちた", { state: "passed" });
    expect(verificationUpdateMany.mock.calls[0][0].data).toMatchObject({ state: "failed", message: "落ちた" });
  });

  it("skippedは何も書かない", async () => {
    expect(await applyReleaseVerifyReport(job, "skipped", null, null)).toBe(false);
    expect(verificationUpdateMany).not.toHaveBeenCalled();
  });
});
