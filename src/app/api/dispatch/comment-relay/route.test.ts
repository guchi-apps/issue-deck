import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMMENT_RELAY_SESSION_INSTRUCTION } from "@/lib/dispatch/comment-relay";

const enqueueSessionControlJob = vi.fn();
const findDispatchSessionForIssue = vi.fn();
const authorizeProgressReport = vi.fn();

vi.mock("@/lib/progress-report-auth", () => ({
  get authorizeProgressReport() {
    return authorizeProgressReport;
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
  return new Request("http://localhost/api/dispatch/comment-relay", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const valid = { repository: "guchi-apps/issue-deck", issue: 3331 };

beforeEach(() => {
  vi.clearAllMocks();
  authorizeProgressReport.mockReturnValue("ok");
  findDispatchSessionForIssue.mockResolvedValue({ host: "subpc", state: "ALIVE" });
  enqueueSessionControlJob.mockResolvedValue({ ok: true, job: { id: "job-1" } });
});

/**
 * `11.local`付きIssueへの`@claude`コメントをローカルセッションへ転送する受け口（#3331）。
 * `reusable-issue-dispatch.yml`のtriageジョブから、共有シークレット認証で呼ばれる。
 */
describe("POST /api/dispatch/comment-relay", () => {
  it("セッションが生きていれば固定文言のINSTRUCTIONを積み、relayed: trueを返す", async () => {
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, relayed: true });
    expect(enqueueSessionControlJob).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 3331,
        hostName: "subpc",
        kind: "INSTRUCTION",
        instruction: COMMENT_RELAY_SESSION_INSTRUCTION,
        recovery: false,
        requestedByUserId: null,
      }),
    );
  });

  it("セッションが生きていなければ積まず、relayed: falseを返す（エラーにはしない）", async () => {
    findDispatchSessionForIssue.mockResolvedValue({ host: "subpc", state: "EXITED" });
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, relayed: false });
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("セッションの記録が無ければ積まず、relayed: falseを返す", async () => {
    findDispatchSessionForIssue.mockResolvedValue(null);
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, relayed: false });
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("積めなかった場合もrelayed: falseで返す", async () => {
    enqueueSessionControlJob.mockResolvedValue({
      ok: false,
      rejection: "already_queued",
      message: "このIssueには未処理の追加指示が既にあります。",
    });
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, relayed: false });
  });

  it("共有シークレットが未設定なら503", async () => {
    authorizeProgressReport.mockReturnValue("not_configured");
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(503);
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("認証に失敗すれば401", async () => {
    authorizeProgressReport.mockReturnValue("unauthorized");
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(401);
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });

  it("リポジトリ・Issue番号が不正なら400", async () => {
    const res = await POST(postRequest({ repository: "invalid", issue: 3331 }));
    expect(res.status).toBe(400);
    expect(enqueueSessionControlJob).not.toHaveBeenCalled();
  });
});
