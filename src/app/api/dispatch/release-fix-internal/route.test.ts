import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(() => "ok"),
  review: vi.fn(),
  test: vi.fn(),
  status: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
}));
vi.mock("@/lib/progress-report-auth", () => ({ authorizeProgressReport: mocks.auth }));
vi.mock("@/lib/release-fix-internal-run", () => ({
  recordInternalReview: mocks.review,
  recordInternalTest: mocks.test,
  readInternalStatus: mocks.status,
  claimInternalSession: mocks.claim,
  releaseInternalSession: mocks.release,
  pauseInternalByReport: mocks.pause,
  resumeInternal: mocks.resume,
}));

import { POST } from "@/app/api/dispatch/release-fix-internal/route";

const call = (body: unknown) =>
  POST(new Request("http://x/api/dispatch/release-fix-internal", { method: "POST", headers: { authorization: "Bearer s" }, body: JSON.stringify(body) }) as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockReturnValue("ok");
});

describe("POST /api/dispatch/release-fix-internal", () => {
  it("認証できなければ401、未設定なら503", async () => {
    mocks.auth.mockReturnValue("unauthorized");
    expect((await call({})).status).toBe(401);
    mocks.auth.mockReturnValue("not_configured");
    expect((await call({})).status).toBe(503);
  });
  it("リポジトリ・Issue・actionが不正なら400（対象SHAは受け取らない）", async () => {
    expect((await call({ action: "review", repository: "bad", issue: 1, verdict: "pass" })).status).toBe(400);
    expect((await call({ action: "nope", repository: "o/r", issue: 1 })).status).toBe(400);
    expect((await call({ action: "review", repository: "o/r", issue: 1 })).status).toBe(400);
  });
  it("reviewはサーバーの記録処理へ渡し、クライアントのSHAを使わない", async () => {
    mocks.review.mockResolvedValue({ ok: true, round: 1, status: { gate: { complete: false } } });
    const res = await call({ action: "review", repository: "o/r", issue: 7, verdict: "findings", sha: "forged", newFindings: [{ title: "a" }] });
    expect(res.status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith({
      repositoryFullName: "o/r",
      issueNumber: 7,
      report: { verdict: "findings", newFindings: [{ title: "a", detail: null }], stillOpen: [], resolved: [] },
      summary: null,
      actor: { assignee: null, epoch: null },
    });
  });
  it("結び付く系列が無ければ404、整合しない報告は409", async () => {
    mocks.test.mockResolvedValue({ ok: false, error: "series_not_found", message: "m" });
    expect((await call({ action: "test", repository: "o/r", issue: 7, state: "passed" })).status).toBe(404);
    mocks.review.mockResolvedValue({ ok: false, error: "invalid_report", message: "m" });
    expect((await call({ action: "review", repository: "o/r", issue: 7, verdict: "pass" })).status).toBe(409);
  });
  it("statusはゲート判定を返す", async () => {
    mocks.status.mockResolvedValue({ ok: true, status: { gate: { complete: true }, rounds: [], findings: [] } });
    const res = await call({ action: "status", repository: "o/r", issue: 7 });
    expect(await res.json()).toMatchObject({ ok: true, gate: { complete: true } });
  });
  it("claimは担当名を必須にし、引き継ぎは明示の指定だけで行う", async () => {
    expect((await call({ action: "claim", repository: "o/r", issue: 7 })).status).toBe(400);
    mocks.claim.mockResolvedValue({ ok: true, epoch: 2, handover: true, status: {} });
    const res = await call({ action: "claim", repository: "o/r", issue: 7, assignee: "agent-b", takeover: true });
    expect(res.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith({ repositoryFullName: "o/r", issueNumber: 7, assignee: "agent-b", takeover: true });
    expect(((await res.json()) as { epoch: number }).epoch).toBe(2);
  });
  it("旧担当の遅延報告・持ち時間内の別担当・停止中の報告は409", async () => {
    for (const error of ["stale_assignee", "lease_held", "paused", "input_required", "not_paused", "not_resumable"]) {
      mocks.test.mockResolvedValue({ ok: false, error, message: "m" });
      expect((await call({ action: "test", repository: "o/r", issue: 7, state: "passed", assignee: "a", epoch: 1 })).status).toBe(409);
    }
  });
  it("エージェントのresumeは入力なしで再開できる停止だけ（予算・方針は画面から）", async () => {
    mocks.resume.mockResolvedValue({ ok: true, status: {} });
    await call({ action: "resume", repository: "o/r", issue: 7, assignee: "a" });
    expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ autoOnly: true }));
  });
  it("pauseはenvironment・needs_decisionだけを受ける", async () => {
    expect((await call({ action: "pause", repository: "o/r", issue: 7, kind: "budget_reached" })).status).toBe(400);
    mocks.pause.mockResolvedValue({ ok: true, status: {} });
    expect((await call({ action: "pause", repository: "o/r", issue: 7, kind: "environment", detail: "529" })).status).toBe(200);
  });
});
