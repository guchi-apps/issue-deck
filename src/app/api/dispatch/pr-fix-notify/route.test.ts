import { beforeEach, describe, expect, it, vi } from "vitest";

import { PR_FIX_SESSION_INSTRUCTION } from "@/lib/dispatch/pr-fix-request";

const enqueueSessionControlJob = vi.fn();
const findDispatchSessionForIssue = vi.fn();
const getCurrentUser = vi.fn();

vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));

vi.mock("@/lib/auth-user", () => ({
  get getCurrentUser() {
    return getCurrentUser;
  },
}));

vi.mock("@/lib/dispatch/jobs", () => ({
  get enqueueSessionControlJob() {
    return enqueueSessionControlJob;
  },
}));

vi.mock("@/lib/dispatch/sessions", () => ({
  get findDispatchSessionForIssue() {
    return findDispatchSessionForIssue;
  },
}));

const { POST } = await import("./route");

function postRequest(body: unknown) {
  return new Request("http://localhost/api/dispatch/pr-fix-notify", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const valid = {
  repository: "guchi-apps/issue-deck",
  issue: 2919,
  hostName: "subpc",
  body: PR_FIX_SESSION_INSTRUCTION,
};

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue({ id: "user-1", githubLogin: "m-guchi" });
  findDispatchSessionForIssue.mockResolvedValue({ host: "subpc", state: "ALIVE" });
  enqueueSessionControlJob.mockResolvedValue({ ok: true, job: { id: "job-1" } });
});

/**
 * 受け口の歯止め（#2919）。**画面の言い分をそのまま流さない**——本文が固定文面であることと、
 * セッションが今も生きていることをサーバー側で確かめ直す（`session-recovery`と同じ立場）。
 */
describe("POST /api/dispatch/pr-fix-notify", () => {
  it("固定文面ならrecoveryを立てたINSTRUCTIONを積む", async () => {
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(200);
    expect(enqueueSessionControlJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "INSTRUCTION",
        instruction: PR_FIX_SESSION_INSTRUCTION,
        // **積んだ時点では確認待ちを外さない。** 外れるのは`succeeded`が届いた時点
        recovery: true,
      }),
    );
  });

  it("固定文面以外は積まない（任意の指示はこの経路に載せない）", async () => {
    const res = await POST(postRequest({ ...valid, body: "@claude CIを直してください" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("セッションが生きていなければ積まない", async () => {
    findDispatchSessionForIssue.mockResolvedValue({ host: "subpc", state: "EXITED" });
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "session_not_alive" });
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("セッションの記録が無くても積まない", async () => {
    findDispatchSessionForIssue.mockResolvedValue(null);
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(409);
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("ログインしていなければ401", async () => {
    getCurrentUser.mockResolvedValue(null);
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(401);
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("積めなかった理由はそのまま返す", async () => {
    enqueueSessionControlJob.mockResolvedValue({
      ok: false,
      rejection: "already_queued",
      message: "このIssueには未処理の追加指示が既にあります。",
    });
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_queued" });
  });
});
