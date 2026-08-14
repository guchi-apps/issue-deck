import { beforeEach, describe, expect, it, vi } from "vitest";

const recordDispatchSessionActivity = vi.fn();
const resolveSessionPlanCheckUser = vi.fn();

vi.mock("@/lib/dispatch/sessions", () => ({
  get recordDispatchSessionActivity() {
    return recordDispatchSessionActivity;
  },
}));

vi.mock("@/lib/dispatch/session-plan", () => ({
  get resolveSessionPlanCheckUser() {
    return resolveSessionPlanCheckUser;
  },
}));

const { POST } = await import("./route");

function postRequest(body: unknown, authorization?: string) {
  return new Request("http://localhost/api/dispatch/sessions/activity", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const target = { repository: "guchi-apps/issue-deck", issue: 1342 };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISPATCH_SECRET = "secret-value";
  recordDispatchSessionActivity.mockResolvedValue({ updated: 1 });
  resolveSessionPlanCheckUser.mockResolvedValue(true);
});

describe("POST /api/dispatch/sessions/activity", () => {
  it("シークレットが一致しなければ401", async () => {
    const res = await POST(postRequest({ ...target, activity: "responded" }, "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(recordDispatchSessionActivity).not.toHaveBeenCalled();
  });

  it("中身が1つも無ければ400", async () => {
    const res = await POST(postRequest(target, "Bearer secret-value"));
    expect(res.status).toBe(400);
    expect(recordDispatchSessionActivity).not.toHaveBeenCalled();
  });

  it("様子をそのまま記録する", async () => {
    const res = await POST(
      postRequest(
        { ...target, activity: "waiting_input", remoteControlUrl: "https://claude.ai/code/s_1" },
        "Bearer secret-value",
      ),
    );
    expect(res.status).toBe(200);
    expect(recordDispatchSessionActivity).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1342,
      activity: "WAITING_INPUT",
      remoteControlUrl: "https://claude.ai/code/s_1",
      previewUrl: null,
    });
    expect(resolveSessionPlanCheckUser).not.toHaveBeenCalled();
  });

  // #1357。承認に答えて作業へ戻ったことの報告。**`00.check-user`には触らない**
  // （外してよいかの判断は`Stop`のときだけホスト側が持つ）
  it("作業再開の報告を受け付ける", async () => {
    const res = await POST(
      postRequest({ ...target, activity: "working" }, "Bearer secret-value"),
    );
    expect(res.status).toBe(200);
    expect(recordDispatchSessionActivity).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1342,
      activity: "WORKING",
      remoteControlUrl: null,
      previewUrl: null,
    });
    expect(resolveSessionPlanCheckUser).not.toHaveBeenCalled();
  });

  /**
   * #1342。**外してよいかの判断はホスト側（`.plan`の印）が持つ。** `Stop`はturnごとに飛ぶため、
   * 受け口が勝手に外すと人が別の理由で付けた`00.check-user`まで落ちる。
   */
  it("planResolvedが真なら00.check-userを外す", async () => {
    const res = await POST(
      postRequest({ ...target, activity: "responded", planResolved: true }, "Bearer secret-value"),
    );
    expect(res.status).toBe(200);
    expect(resolveSessionPlanCheckUser).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1342,
      });
  });

  it("planResolvedが偽なら外さない", async () => {
    await POST(
      postRequest({ ...target, activity: "responded", planResolved: false }, "Bearer secret-value"),
    );
    expect(resolveSessionPlanCheckUser).not.toHaveBeenCalled();
  });

  // ラベルを外すことだけを伝える報告も受け付ける（様子が無くても400にしない）
  it("planResolvedだけでも受け付ける", async () => {
    const res = await POST(postRequest({ ...target, planResolved: true }, "Bearer secret-value"));
    expect(res.status).toBe(200);
    expect(resolveSessionPlanCheckUser).toHaveBeenCalled();
  });
});
