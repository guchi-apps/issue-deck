import { beforeEach, describe, expect, it, vi } from "vitest";

const decideSessionPlanRequest = vi.fn();
const resolveSessionPlanCheckUser = vi.fn();
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
}));

vi.mock("@/lib/dispatch/session-plan", () => ({
  get resolveSessionPlanCheckUser() {
    return resolveSessionPlanCheckUser;
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
});
