import { beforeEach, describe, expect, it, vi } from "vitest";

const decideSessionQuestionRequest = vi.fn();
const findSessionQuestionRequestQuestions = vi.fn();
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

vi.mock("@/lib/dispatch/question-requests", () => ({
  get decideSessionQuestionRequest() {
    return decideSessionQuestionRequest;
  },
  get findSessionQuestionRequestQuestions() {
    return findSessionQuestionRequestQuestions;
  },
}));

vi.mock("@/lib/dispatch/session-plan", () => ({
  get resolveSessionPlanCheckUser() {
    return resolveSessionPlanCheckUser;
  },
}));

// 手作業Issue（`71.manual-step`）かどうかはDBのIssueキャッシュのラベルで見る（#2771）。
// 既定は「手作業ではない」（従来どおりコメントが残る）
const issueLabels = vi.fn<() => { name: string }[]>(() => []);
vi.mock("@/lib/db", () => ({
  db: {
    repository: { findFirst: async () => ({ id: "repo-1" }) },
    issue: { findFirst: async () => ({ labels: issueLabels() }) },
  },
}));

vi.mock("@/lib/github/issues-api", () => ({
  get createComment() {
    return createComment;
  },
}));

const { POST } = await import("./route");

function postRequest(body: unknown) {
  return new Request("http://localhost/api/dispatch/question-answer", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const questions = [
  { question: "どちらにしますか", header: "方針", multiSelect: false, options: [{ label: "A" }] },
];

const request = {
  id: "question-1",
  repositoryFullName: "guchi-apps/issue-deck",
  issueNumber: 2341,
  questions,
};

const answerBody = {
  id: "question-1",
  decision: "answer",
  answers: [{ question: "どちらにしますか", options: ["A"] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  issueLabels.mockReturnValue([]);
  getCurrentUser.mockResolvedValue({ id: "user-1", githubLogin: "m-guchi" });
  findSessionQuestionRequestQuestions.mockResolvedValue(questions);
  decideSessionQuestionRequest.mockResolvedValue({ ok: true, request });
  resolveSessionPlanCheckUser.mockResolvedValue(true);
  createComment.mockResolvedValue({});
});

describe("POST /api/dispatch/question-answer", () => {
  it("ログインしていなければ401", async () => {
    getCurrentUser.mockResolvedValue(null);
    const res = await POST(postRequest(answerBody));
    expect(res.status).toBe(401);
    expect(decideSessionQuestionRequest).not.toHaveBeenCalled();
  });

  // #2341。画面から答えた回は選択フォームが出ず、フックの「答えた合図」が飛ばない
  it("回答したら00.check-userをその場で外す", async () => {
    const res = await POST(postRequest(answerBody));
    expect(res.status).toBe(200);
    expect(resolveSessionPlanCheckUser).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2341,
    });
  });

  it("端末・Remote Controlで答える場合は外さない", async () => {
    const res = await POST(postRequest({ id: "question-1", decision: "defer" }));
    expect(res.status).toBe(200);
    expect(resolveSessionPlanCheckUser).not.toHaveBeenCalled();
  });

  it("回答を保存できなければ外さない", async () => {
    decideSessionQuestionRequest.mockResolvedValue({ ok: false, rejection: "not_found" });
    const res = await POST(postRequest(answerBody));
    expect(res.status).toBe(409);
    expect(resolveSessionPlanCheckUser).not.toHaveBeenCalled();
  });

  it("ラベルを外せなくても200で返す", async () => {
    resolveSessionPlanCheckUser.mockResolvedValue(false);
    const res = await POST(postRequest(answerBody));
    expect(res.status).toBe(200);
  });
});

describe("手作業Issueへの回答（#2771）", () => {
  // 手作業セッションは手順ごとに「次へ進みますか」と聞くため、残すと手順の数だけコメントが増える
  it("71.manual-stepのIssueではIssueコメントを残さない（回答はDBに残る）", async () => {
    issueLabels.mockReturnValue([{ name: "71.manual-step" }]);
    const res = await POST(postRequest(answerBody));
    expect(res.status).toBe(200);
    expect(decideSessionQuestionRequest).toHaveBeenCalledTimes(1);
    expect(createComment).not.toHaveBeenCalled();
  });

  it("手作業Issueでなければ従来どおりコメントを残す", async () => {
    const res = await POST(postRequest(answerBody));
    expect(res.status).toBe(200);
    expect(createComment).toHaveBeenCalledTimes(1);
  });
});
