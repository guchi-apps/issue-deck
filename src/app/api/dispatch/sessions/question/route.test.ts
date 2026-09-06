import { beforeEach, describe, expect, it, vi } from "vitest";

const createSessionQuestionRequest = vi.fn();
const requestSessionCheckUser = vi.fn();
const isSessionAnswerInApp = vi.fn();

vi.mock("@/lib/dispatch/question-requests", () => ({
  get createSessionQuestionRequest() {
    return createSessionQuestionRequest;
  },
}));

vi.mock("@/lib/dispatch/session-plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dispatch/session-plan")>();
  return {
    ...actual,
    get requestSessionCheckUser() {
      return requestSessionCheckUser;
    },
  };
});

// 「アプリで答える」（#2822）。DBを引かずに、ONとOFFの分岐だけを確かめる
vi.mock("@/lib/dispatch/session-answer-mode", () => ({
  get isSessionAnswerInApp() {
    return isSessionAnswerInApp;
  },
}));

const { POST } = await import("./route");

function postRequest(body: unknown, authorization?: string) {
  return new Request("http://localhost/api/dispatch/sessions/question", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const validBody = {
  repository: "guchi-apps/issue-deck",
  issue: 2189,
  questions: [
    {
      question: "この方針で進めてよいですか？",
      header: "方針",
      multiSelect: false,
      options: [
        { label: "進める", description: "そのまま実装します" },
        { label: "見直す", description: "別の案を検討します" },
      ],
    },
  ],
  hostName: "subpc",
  waitSeconds: 300,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISPATCH_SECRET = "secret-value";
  createSessionQuestionRequest.mockResolvedValue({ id: "question-request-1" });
  requestSessionCheckUser.mockResolvedValue(true);
  isSessionAnswerInApp.mockResolvedValue(false);
});

describe("POST /api/dispatch/sessions/question", () => {
  it("既定では回答待ちを作り、確認待ちのラベルを付ける", async () => {
    const res = await POST(postRequest(validBody, "Bearer secret-value"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      labeled: true,
      questionRequestId: "question-request-1",
      answerInApp: false,
    });
  });

  /**
   * 「アプリで答える」がON（#2822）。**待ちを作らない**ので、フックはすぐ降りてClaude Codeが
   * 端末へ選択フォームを出す（それがClaude Codeアプリにも見える）。
   *
   * **`00.check-user`は付けたまま。** 人を待っているのは変わらず、ここを一緒に止めると
   * 答え先が変わっただけのはずが「何も起きていない」ように見える。
   */
  it("アプリで答えるがONなら、待ちを作らずラベルだけ付ける", async () => {
    isSessionAnswerInApp.mockResolvedValue(true);

    const res = await POST(postRequest(validBody, "Bearer secret-value"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      questionRequestId: null,
      labeled: true,
      answerInApp: true,
    });
    expect(createSessionQuestionRequest).not.toHaveBeenCalled();
    expect(requestSessionCheckUser).toHaveBeenCalledTimes(1);
  });

  it("待ち時間が0なら作らない", async () => {
    const res = await POST(
      postRequest({ ...validBody, waitSeconds: 0 }, "Bearer secret-value"),
    );

    await expect(res.json()).resolves.toMatchObject({ questionRequestId: null });
    expect(createSessionQuestionRequest).not.toHaveBeenCalled();
  });

  it("共有シークレットが合わなければ401", async () => {
    const res = await POST(postRequest(validBody, "Bearer wrong"));
    expect(res.status).toBe(401);
  });

  it("質問が読めなければ400", async () => {
    const res = await POST(
      postRequest({ ...validBody, questions: [] }, "Bearer secret-value"),
    );
    expect(res.status).toBe(400);
  });
});
