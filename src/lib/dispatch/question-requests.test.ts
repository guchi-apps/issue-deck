import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionQuestionRequestCreate = vi.fn();
const sessionQuestionRequestUpdateMany = vi.fn();
const clearDispatchSessionWaitingTool = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    sessionQuestionRequest: {
      get create() {
        return sessionQuestionRequestCreate;
      },
      get updateMany() {
        return sessionQuestionRequestUpdateMany;
      },
    },
  },
}));

vi.mock("@/lib/dispatch/sessions", () => ({
  get clearDispatchSessionWaitingTool() {
    return clearDispatchSessionWaitingTool;
  },
}));

import { createSessionQuestionRequest } from "@/lib/dispatch/question-requests";

const NOW = new Date("2026-09-17T19:00:00.000Z");

/** `SessionQuestionRequest`の行のうち、ここで見るものだけを持つ最小の形 */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 2985,
    hostName: "subpc",
    questions: JSON.stringify([{ question: "進めますか？", header: "方針", options: [] }]),
    answers: null,
    status: "WAITING",
    createdAt: NOW,
    decidedAt: null,
    expiresAt: new Date(NOW.getTime() + 30 * 60 * 1000),
    deliveredAt: null,
    ...overrides,
  };
}

/**
 * #2985。**質問の待ちは`activity`を動かさない**（#2238）ので、直前の許可待ちで入った
 * `waitingTool`をここで捨てないと、画面に「質問に答える」と「許可待ち」が並んで出る
 * （許可を拒否した後に質問したときも同じ形になる）。
 */
describe("createSessionQuestionRequest", () => {
  beforeEach(() => {
    sessionQuestionRequestUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    sessionQuestionRequestCreate.mockReset().mockResolvedValue(row());
    clearDispatchSessionWaitingTool.mockReset().mockResolvedValue({ updated: 1 });
  });

  it("直前の許可待ちの説明を捨てる", async () => {
    await createSessionQuestionRequest({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2985,
      hostName: "subpc",
      questions: [{ question: "進めますか？", header: "方針", multiSelect: false, options: [] }],
      waitSeconds: 1800,
      now: NOW,
    });

    expect(clearDispatchSessionWaitingTool).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2985,
    });
  });

  it("同じIssueの古い待ちを畳んでから作る", async () => {
    await createSessionQuestionRequest({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2985,
      hostName: "subpc",
      questions: [{ question: "進めますか？", header: "方針", multiSelect: false, options: [] }],
      waitSeconds: 1800,
      now: NOW,
    });

    expect(sessionQuestionRequestUpdateMany).toHaveBeenCalledWith({
      where: {
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 2985,
        status: "WAITING",
      },
      data: { status: "EXPIRED" },
    });
  });
});
