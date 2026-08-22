import { beforeEach, describe, expect, it, vi } from "vitest";

const postSessionPlan = vi.fn();
const createSessionPlanRequest = vi.fn();

vi.mock("@/lib/dispatch/session-plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dispatch/session-plan")>();
  return {
    ...actual,
    get postSessionPlan() {
      return postSessionPlan;
    },
  };
});

// 画面からの返事待ち（#2061）。**投稿できたときだけ作る**ので、`postSessionPlan`の
// 戻り値と対で確かめる
vi.mock("@/lib/dispatch/plan-requests", () => ({
  get createSessionPlanRequest() {
    return createSessionPlanRequest;
  },
}));

const { POST } = await import("./route");

function postRequest(body: unknown, authorization?: string) {
  return new Request("http://localhost/api/dispatch/sessions/plan", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const validBody = {
  repository: "guchi-apps/issue-deck",
  issue: 1342,
  plan: "## アプローチ\n- あれをする",
  remoteControlUrl: "https://claude.ai/code/session_01ABC",
  planBaseSha: "baf823f30a2ef7d8f80ff95665e7034e67d70171",
  hostName: "subpc",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISPATCH_SECRET = "secret-value";
  postSessionPlan.mockResolvedValue(true);
  createSessionPlanRequest.mockResolvedValue({ id: "plan-request-1" });
});

describe("POST /api/dispatch/sessions/plan", () => {
  it("DISPATCH_SECRET未設定なら503（値の不一致と区別できるようにする）", async () => {
    delete process.env.DISPATCH_SECRET;
    const res = await POST(postRequest(validBody, "Bearer secret-value"));
    expect(res.status).toBe(503);
    expect(postSessionPlan).not.toHaveBeenCalled();
  });

  it("シークレットが一致しなければ401", async () => {
    const res = await POST(postRequest(validBody, "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(postSessionPlan).not.toHaveBeenCalled();
  });

  it("宛先が不正なら400", async () => {
    const res = await POST(
      postRequest({ ...validBody, repository: "issue-deck" }, "Bearer secret-value"),
    );
    expect(res.status).toBe(400);
    expect(postSessionPlan).not.toHaveBeenCalled();
  });

  it("計画が空なら400（中身の無いコメントを投稿しない）", async () => {
    const res = await POST(postRequest({ ...validBody, plan: "  " }, "Bearer secret-value"));
    expect(res.status).toBe(400);
    expect(postSessionPlan).not.toHaveBeenCalled();
  });

  it("受け付けた計画をそのまま渡す", async () => {
    const res = await POST(postRequest(validBody, "Bearer secret-value"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, posted: true, planRequestId: "plan-request-1" });
    expect(postSessionPlan).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1342,
      plan: "## アプローチ\n- あれをする",
      remoteControlUrl: "https://claude.ai/code/session_01ABC",
      planBaseSha: "baf823f30a2ef7d8f80ff95665e7034e67d70171",
      hostName: "subpc",
    });
  });

  /**
   * 付随情報の形が想定外でも**計画は投稿する**。計画本文が残ることの方が価値が高く、
   * リンクやSHAが欠けても投稿する意味は変わらない。
   */
  it("Remote ControlのURL・SHA・ホスト名が不正でも計画は投稿する", async () => {
    const res = await POST(
      postRequest(
        {
          ...validBody,
          remoteControlUrl: "https://example.com/evil",
          planBaseSha: "-->",
          hostName: "**bold**",
        },
        "Bearer secret-value",
      ),
    );
    expect(res.status).toBe(200);
    expect(postSessionPlan).toHaveBeenCalledWith(
      expect.objectContaining({ remoteControlUrl: null, planBaseSha: null, hostName: null }),
    );
  });

  // 呼び出し側（フック）は再送の判断ができる相手ではない。非0を返してもセッションのログに
  // エラーが増えるだけになる
  it("投稿できなくても200で返す", async () => {
    postSessionPlan.mockResolvedValue(false);
    const res = await POST(postRequest(validBody, "Bearer secret-value"));
    expect(res.status).toBe(200);
    // 投稿できていない＝画面に計画が出ないので、返事待ちも作らない（#2061）
    expect(await res.json()).toEqual({ ok: true, posted: false, planRequestId: null });
    expect(createSessionPlanRequest).not.toHaveBeenCalled();
  });

  /**
   * 返事待ちを作れなくても、計画の投稿そのものは成功として返す（#2061）。待てないだけで、
   * 答える経路（端末・Remote Control）はそのまま残っている。
   */
  it("返事待ちを作れなくても計画の投稿は成功として返す", async () => {
    createSessionPlanRequest.mockRejectedValue(new Error("db down"));
    const res = await POST(postRequest(validBody, "Bearer secret-value"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, posted: true, planRequestId: null });
  });
});
