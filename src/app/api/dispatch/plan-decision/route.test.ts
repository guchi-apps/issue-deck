import { beforeEach, describe, expect, it, vi } from "vitest";

const decideSessionPlanRequest = vi.fn();
const recordSessionPlanCodexDelivery = vi.fn();
const notifyCodexSessionDecision = vi.fn();
const resolveSessionPlanCheckUser = vi.fn();
const advanceSessionPlanProgress = vi.fn();
const createComment = vi.fn();
const getCurrentUser = vi.fn();

vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));

vi.mock("@/lib/auth-user", () => ({
  get getCurrentUser() {
    return getCurrentUser;
  },
}));

vi.mock("@/lib/dispatch/installation-token", () => ({
  resolveInstallationToken: async () => "token",
}));

vi.mock("@/lib/dispatch/plan-requests", () => ({
  get decideSessionPlanRequest() {
    return decideSessionPlanRequest;
  },
  get recordSessionPlanCodexDelivery() {
    return recordSessionPlanCodexDelivery;
  },
}));

vi.mock("@/lib/dispatch/codex-decision-notify", () => ({
  get notifyCodexSessionDecision() {
    return notifyCodexSessionDecision;
  },
}));

vi.mock("@/lib/dispatch/session-plan", () => ({
  get resolveSessionPlanCheckUser() {
    return resolveSessionPlanCheckUser;
  },
}));

vi.mock("@/lib/dispatch/session-plan-progress", () => ({
  get advanceSessionPlanProgress() {
    return advanceSessionPlanProgress;
  },
}));

vi.mock("@/lib/github/issues-api", () => ({
  get createComment() {
    return createComment;
  },
}));

const { POST } = await import("./route");

function postRequest(body: unknown) {
  return new Request("http://localhost/api/dispatch/plan-decision", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const request = {
  id: "plan-1",
  repositoryFullName: "guchi-apps/issue-deck",
  issueNumber: 2341,
};

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue({ id: "user-1", githubLogin: "m-guchi" });
  decideSessionPlanRequest.mockResolvedValue({ ok: true, request });
  resolveSessionPlanCheckUser.mockResolvedValue(true);
  advanceSessionPlanProgress.mockResolvedValue(true);
  recordSessionPlanCodexDelivery.mockResolvedValue(undefined);
  notifyCodexSessionDecision.mockResolvedValue({ ok: false, reason: "not_codex", message: "" });
  createComment.mockResolvedValue({});
});

describe("POST /api/dispatch/plan-decision", () => {
  it("ログインしていなければ401", async () => {
    getCurrentUser.mockResolvedValue(null);
    const res = await POST(postRequest({ id: "plan-1", decision: "approve" }));
    expect(res.status).toBe(401);
    expect(decideSessionPlanRequest).not.toHaveBeenCalled();
  });

  /**
   * #2341。画面から答えた回は承認プロンプトが出ず、フックの「答えた合図」（`PostToolUse`）が
   * 飛ばないため、ここで外さないと`Stop`（実装が全部終わるまで）まで確認待ちが残る。
   */
  it("承認したら00.check-userをその場で外す", async () => {
    const res = await POST(postRequest({ id: "plan-1", decision: "approve" }));
    expect(res.status).toBe(200);
    expect(resolveSessionPlanCheckUser).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2341,
    });
  });

  it("修正を送ったときも外す", async () => {
    const res = await POST(
      postRequest({ id: "plan-1", decision: "revise", text: "分割を検討してください" }),
    );
    expect(res.status).toBe(200);
    expect(resolveSessionPlanCheckUser).toHaveBeenCalledTimes(1);
  });

  // 端末で答えると言っただけで、人はまだ答えていない。外すと待たれていること自体が消える
  it("端末・Remote Controlで答える場合は外さない", async () => {
    const res = await POST(postRequest({ id: "plan-1", decision: "defer" }));
    expect(res.status).toBe(200);
    expect(resolveSessionPlanCheckUser).not.toHaveBeenCalled();
  });

  it("返事を保存できなければ外さない", async () => {
    decideSessionPlanRequest.mockResolvedValue({ ok: false, rejection: "not_found" });
    const res = await POST(postRequest({ id: "plan-1", decision: "approve" }));
    expect(res.status).toBe(409);
    expect(resolveSessionPlanCheckUser).not.toHaveBeenCalled();
  });

  // ラベルを外せなくても返事はもうDBに入っている。失敗を返すと押し直すことになる
  it("ラベルを外せなくても200で返す", async () => {
    resolveSessionPlanCheckUser.mockResolvedValue(false);
    const res = await POST(postRequest({ id: "plan-1", decision: "approve" }));
    expect(res.status).toBe(200);
  });

  /**
   * #3213。ローカルセッションには承認を受けて進捗を進める経路が無く、承認しても「計画」の
   * まま次のPR作成まで動かなかった。
   */
  it("承認したら進捗を実装へ進める", async () => {
    const res = await POST(postRequest({ id: "plan-1", decision: "approve" }));
    expect(res.status).toBe(200);
    expect(advanceSessionPlanProgress).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2341,
    });
  });

  it("修正・端末で答える場合、返事を保存できなかった場合は進捗を進めない", async () => {
    await POST(postRequest({ id: "plan-1", decision: "revise", text: "直してください" }));
    await POST(postRequest({ id: "plan-1", decision: "defer" }));
    decideSessionPlanRequest.mockResolvedValue({ ok: false, rejection: "not_found" });
    await POST(postRequest({ id: "plan-1", decision: "approve" }));
    expect(advanceSessionPlanProgress).not.toHaveBeenCalled();
  });

  it("進捗を進められなくても200で返す", async () => {
    advanceSessionPlanProgress.mockResolvedValue(false);
    const res = await POST(postRequest({ id: "plan-1", decision: "approve" }));
    expect(res.status).toBe(200);
  });

  /**
   * #3218。Codexは`submit-plan.sh`の完了を待たずにターンを終えるため、判断を取りに来る
   * 当事者がいない。判断が決まった時点でこちらから継続指示を積む。
   */
  it("承認・修正ではCodexのセッションへ継続指示を積む", async () => {
    notifyCodexSessionDecision.mockResolvedValue({ ok: true, jobId: "job-1" });

    await POST(postRequest({ id: "plan-1", decision: "approve" }));
    expect(notifyCodexSessionDecision).toHaveBeenLastCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2341,
      kind: "plan-approved",
      requestedByUserId: "user-1",
    });

    await POST(postRequest({ id: "plan-1", decision: "revise", text: "直してください" }));
    expect(notifyCodexSessionDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "plan-revision" }),
    );
    expect(recordSessionPlanCodexDelivery).toHaveBeenLastCalledWith({
      id: "plan-1",
      queued: true,
      summary: null,
    });
  });

  it("端末で答える場合は積まない（人はまだ答えていない）", async () => {
    await POST(postRequest({ id: "plan-1", decision: "defer" }));
    expect(notifyCodexSessionDecision).not.toHaveBeenCalled();
    expect(recordSessionPlanCodexDelivery).not.toHaveBeenCalled();
  });

  // Claude Codeのセッションはフックが判断を取りに来る。配送の記録もそちらに任せる
  it("Claude Codeのセッション・セッション不明のときは配送の記録を書かない", async () => {
    for (const reason of ["not_codex", "no_session"]) {
      notifyCodexSessionDecision.mockResolvedValue({ ok: false, reason, message: "" });
      await POST(postRequest({ id: "plan-1", decision: "approve" }));
    }
    expect(recordSessionPlanCodexDelivery).not.toHaveBeenCalled();
  });

  it("Codexへ積めなかった理由は配送の記録として残す", async () => {
    notifyCodexSessionDecision.mockResolvedValue({
      ok: false,
      reason: "not_alive",
      message: "Codexのセッションが動いていません。",
    });
    const res = await POST(postRequest({ id: "plan-1", decision: "approve" }));
    expect(res.status).toBe(200);
    expect(recordSessionPlanCodexDelivery).toHaveBeenCalledWith({
      id: "plan-1",
      queued: false,
      summary: "Codexのセッションが動いていません。",
    });
  });
});
