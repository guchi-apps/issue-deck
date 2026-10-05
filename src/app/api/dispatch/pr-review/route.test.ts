import { beforeEach, describe, expect, it, vi } from "vitest";

const authorizeProgressReport = vi.fn();
const requestPrReviewJob = vi.fn();
const getPrReviewGate = vi.fn();

vi.mock("@/lib/progress-report-auth", () => ({
  get authorizeProgressReport() {
    return authorizeProgressReport;
  },
}));
vi.mock("@/lib/dispatch/pr-review-jobs", () => ({
  get requestPrReviewJob() {
    return requestPrReviewJob;
  },
  get getPrReviewGate() {
    return getPrReviewGate;
  },
}));

const { POST } = await import("./route");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/dispatch/pr-review", {
      method: "POST",
      headers: { authorization: "Bearer s" },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
  );
}

const valid = {
  action: "request",
  repository: "guchi-apps/issue-deck",
  pullRequest: 7,
  headSha: HEAD,
  baseSha: BASE,
  agent: "codex",
  runId: 123456,
};

beforeEach(() => {
  vi.clearAllMocks();
  authorizeProgressReport.mockReturnValue("ok");
});

describe("POST /api/dispatch/pr-review", () => {
  it("認証できなければ401、未設定なら503", async () => {
    authorizeProgressReport.mockReturnValue("unauthorized");
    expect((await post(valid)).status).toBe(401);
    authorizeProgressReport.mockReturnValue("not_configured");
    expect((await post(valid)).status).toBe(503);
  });

  it("形が不正な入力は400（SHA・PR番号・リポジトリ名・actionを検証する）", async () => {
    for (const patch of [
      { headSha: "abc" },
      { baseSha: undefined },
      { pullRequest: 0 },
      { repository: "../etc" },
      { action: "delete" },
      { agent: "gemini" },
    ]) {
      expect((await post({ ...valid, ...patch })).status).toBe(400);
    }
    expect(requestPrReviewJob).not.toHaveBeenCalled();
  });

  it("依頼は積んで状態を返す（結果は待たない）", async () => {
    requestPrReviewJob.mockResolvedValue({
      ok: true,
      created: true,
      job: { id: "job-1" },
      gate: { state: "pending", phase: "queued", host: "subpc" },
    });
    const response = await post(valid);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "pending", created: true, jobId: "job-1" });
    expect(requestPrReviewJob).toHaveBeenCalledWith({
      target: { repositoryFullName: "guchi-apps/issue-deck", prNumber: 7, headSha: HEAD, agent: "codex" },
      baseSha: BASE,
      workflowRunId: "123456",
    });
  });

  it("実行できるサブPCが無ければ409で理由を返す（Actionsが30分待たずに失敗できる）", async () => {
    requestPrReviewJob.mockResolvedValue({ ok: false, rejection: "no_host", message: "実行できるサブPCがありません" });
    const response = await post(valid);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ state: "failed", reason: "実行できるサブPCがありません" });
  });

  it("状態の取得は積まずに、最新のジョブの状態を返す（baseShaは不要）", async () => {
    getPrReviewGate.mockResolvedValue({
      job: { id: "job-1", claimedByHost: "subpc", targetHost: "subpc" },
      gate: { state: "done", verdict: "lgtm" },
    });
    const response = await post({ ...valid, action: "status", baseSha: undefined });
    expect(await response.json()).toMatchObject({ state: "done", verdict: "lgtm", host: "subpc" });
    expect(requestPrReviewJob).not.toHaveBeenCalled();
  });
});
