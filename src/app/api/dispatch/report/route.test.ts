import { beforeEach, describe, expect, it, vi } from "vitest";

import { PR_FIX_SESSION_INSTRUCTION } from "@/lib/dispatch/pr-fix-request";

const reportDispatchJob = vi.fn();
const resolveFixedInstructionCheckUser = vi.fn();

vi.mock("@/lib/dispatch/dispatch-auth", () => ({
  authorizeDispatch: () => "ok",
}));

vi.mock("@/lib/dispatch/jobs", () => ({
  get reportDispatchJob() {
    return reportDispatchJob;
  },
}));

vi.mock("@/lib/dispatch/session-escalation", () => ({
  get resolveFixedInstructionCheckUser() {
    return resolveFixedInstructionCheckUser;
  },
}));

vi.mock("@/lib/manual-step-run", () => ({ advanceManualStepRun: vi.fn() }));
vi.mock("@/lib/manual-step-verification-patrol", () => ({
  advanceManualStepVerificationCheck: vi.fn(),
  recordManualStepVerificationPass: vi.fn(),
}));

const { POST } = await import("./route");

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    kind: "INSTRUCTION",
    recovery: true,
    instruction: PR_FIX_SESSION_INSTRUCTION,
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 2919,
    ...overrides,
  };
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/dispatch/report", {
    method: "POST",
    headers: { authorization: "Bearer token" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const succeeded = { jobId: "job-1", host: "subpc", status: "succeeded" };

/**
 * 停滞からの復旧で送られる文面（#2886）。**`session-stall.ts`は本文を公開していない**ので、
 * ここでは「修正依頼の1行ではない`recovery`ジョブ」の代表として置いている——見分けているのは
 * 「修正依頼の1行と一致するか」の1点なので、他のどの文面でも結果は同じ。
 */
const STALL_RECOVERY_BODY =
  "直前の応答がAPIエラーで中断しました。中断したところから作業を続けてください。";

beforeEach(() => {
  vi.clearAllMocks();
  reportDispatchJob.mockResolvedValue({ ok: true, applied: true, job: job() });
  resolveFixedInstructionCheckUser.mockResolvedValue(true);
});

/**
 * 固定文面が届いた時点の確認待ちの片付け（#2886・#2919）。
 *
 * **どちらの経路も`recovery`で積まれるので、送った本文で見分ける。** ここを取り違えると、
 * 停滞からの復旧でマージ待ちの札まで落ちるか、修正依頼を送っても札が残るかのどちらかになる。
 */
describe("POST /api/dispatch/report の確認待ち解除", () => {
  it("マージ待ちの修正依頼が届いたら、01.check-mergeも外してよいと伝える", async () => {
    await POST(postRequest(succeeded));
    expect(resolveFixedInstructionCheckUser).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2919,
      allowMergeReason: true,
    });
  });

  it("停滞からの復旧では01.check-mergeを外させない", async () => {
    reportDispatchJob.mockResolvedValue({
      ok: true,
      applied: true,
      job: job({ instruction: STALL_RECOVERY_BODY }),
    });
    await POST(postRequest(succeeded));
    expect(resolveFixedInstructionCheckUser).toHaveBeenCalledWith(
      expect.objectContaining({ allowMergeReason: false }),
    );
  });

  it("recoveryが立っていないINSTRUCTIONでは何も外さない", async () => {
    reportDispatchJob.mockResolvedValue({
      ok: true,
      applied: true,
      job: job({ recovery: false }),
    });
    await POST(postRequest(succeeded));
    expect(resolveFixedInstructionCheckUser).not.toHaveBeenCalled();
  });

  it("succeeded以外では何も外さない（見送られた報告で札を消さない）", async () => {
    await POST(postRequest({ ...succeeded, status: "skipped" }));
    expect(resolveFixedInstructionCheckUser).not.toHaveBeenCalled();
  });
});
