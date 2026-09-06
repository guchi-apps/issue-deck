import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchSessionFindUnique = vi.fn();
const dispatchSessionFindFirst = vi.fn();
const dispatchSessionUpdate = vi.fn();
const dispatchSessionUpdateMany = vi.fn();
const planRequestFindFirst = vi.fn();
const questionRequestFindFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    dispatchSession: {
      get findUnique() {
        return dispatchSessionFindUnique;
      },
      get findFirst() {
        return dispatchSessionFindFirst;
      },
      get update() {
        return dispatchSessionUpdate;
      },
      get updateMany() {
        return dispatchSessionUpdateMany;
      },
    },
    sessionPlanRequest: {
      get findFirst() {
        return planRequestFindFirst;
      },
    },
    sessionQuestionRequest: {
      get findFirst() {
        return questionRequestFindFirst;
      },
    },
  },
}));

const decideSessionPlanRequest = vi.fn();
const decideSessionQuestionRequest = vi.fn();

vi.mock("@/lib/dispatch/plan-requests", () => ({
  get decideSessionPlanRequest() {
    return decideSessionPlanRequest;
  },
}));
vi.mock("@/lib/dispatch/question-requests", () => ({
  get decideSessionQuestionRequest() {
    return decideSessionQuestionRequest;
  },
}));

import {
  deferPendingSessionRequests,
  isSessionAnswerInApp,
  parseSessionAnswerInApp,
  resetSessionAnswerInApp,
  setSessionAnswerInApp,
} from "@/lib/dispatch/session-answer-mode";

beforeEach(() => {
  vi.clearAllMocks();
  planRequestFindFirst.mockResolvedValue(null);
  questionRequestFindFirst.mockResolvedValue(null);
});

describe("parseSessionAnswerInApp", () => {
  it("真偽値だけを通す", () => {
    expect(parseSessionAnswerInApp(true)).toBe(true);
    expect(parseSessionAnswerInApp(false)).toBe(false);
  });

  // **既定へ倒さない。** 倒すと、押した向きが黙って反対になる
  it("真偽値以外はnull", () => {
    expect(parseSessionAnswerInApp("true")).toBeNull();
    expect(parseSessionAnswerInApp(1)).toBeNull();
    expect(parseSessionAnswerInApp(undefined)).toBeNull();
  });
});

describe("setSessionAnswerInApp", () => {
  it("生きているセッションには書き込める", async () => {
    dispatchSessionFindUnique.mockResolvedValue({ state: "ALIVE", codexThreadKnown: null });

    const result = await setSessionAnswerInApp({
      host: "subpc",
      tmuxSessionName: "issue-deck-issue-2822",
      answerInApp: true,
    });

    expect(result).toEqual({ ok: true });
    expect(dispatchSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { answerInApp: true } }),
    );
  });

  // 終わったセッションに書いても、次に同じ名前で立ち上がった行では捨てられる
  it("終了したセッションは断る", async () => {
    dispatchSessionFindUnique.mockResolvedValue({ state: "GONE", codexThreadKnown: null });

    const result = await setSessionAnswerInApp({
      host: "subpc",
      tmuxSessionName: "issue-deck-issue-2822",
      answerInApp: true,
    });

    expect(result).toEqual({ ok: false, rejection: "not_alive" });
    expect(dispatchSessionUpdate).not.toHaveBeenCalled();
  });

  /**
   * Codexのセッションでは断る（計画レビューの指摘1）。**画面で出し分けるだけにしない。**
   * Codexの質問も同じ受け口へ登録し、`questionRequestId`が返らないと`submit-question.sh`は
   * 終了コード3で端末へ倒れるが、CodexにはRemote Controlが無い＝答える出口が消える
   */
  it("Codexのセッションは断る", async () => {
    dispatchSessionFindUnique.mockResolvedValue({ state: "ALIVE", codexThreadKnown: true });

    const result = await setSessionAnswerInApp({
      host: "subpc",
      tmuxSessionName: "issue-deck-issue-2822",
      answerInApp: true,
    });

    expect(result).toEqual({ ok: false, rejection: "codex" });
    expect(dispatchSessionUpdate).not.toHaveBeenCalled();
  });

  it("行が無ければ断る", async () => {
    dispatchSessionFindUnique.mockResolvedValue(null);

    const result = await setSessionAnswerInApp({
      host: "subpc",
      tmuxSessionName: "issue-deck-issue-2822",
      answerInApp: false,
    });

    expect(result).toEqual({ ok: false, rejection: "not_found" });
  });
});

describe("isSessionAnswerInApp", () => {
  it("生きているセッションのONを読む", async () => {
    dispatchSessionFindFirst.mockResolvedValue({ answerInApp: true });

    await expect(
      isSessionAnswerInApp({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 2822,
        hostName: "subpc",
      }),
    ).resolves.toBe(true);
    expect(dispatchSessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ state: "ALIVE", host: "subpc" }),
      }),
    );
  });

  // pollerが1巡する前に質問が出ると行がまだ無い。**そのときは既定（画面で受け取る）**
  it("行が無ければfalse", async () => {
    dispatchSessionFindFirst.mockResolvedValue(null);

    await expect(
      isSessionAnswerInApp({
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 2822,
        hostName: null,
      }),
    ).resolves.toBe(false);
    // ホスト名が無ければ絞らない（絞ると1件も引けなくなる）
    expect(dispatchSessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ host: expect.anything() }),
      }),
    );
  });
});

describe("deferPendingSessionRequests", () => {
  it("待機中の計画・質問を`defer`で畳む", async () => {
    planRequestFindFirst.mockResolvedValue({ id: "plan-1" });
    questionRequestFindFirst.mockResolvedValue({ id: "question-1" });
    decideSessionPlanRequest.mockResolvedValue({ ok: true, request: {} });
    decideSessionQuestionRequest.mockResolvedValue({ ok: true, request: {} });

    const result = await deferPendingSessionRequests({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2822,
      decidedByUserId: "user-1",
    });

    expect(result).toEqual({ plan: true, question: true });
    expect(decideSessionPlanRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plan-1", decision: "defer" }),
    );
    expect(decideSessionQuestionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "question-1", decision: "defer" }),
    );
  });

  it("待っているものが無ければ何も畳まない", async () => {
    const result = await deferPendingSessionRequests({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2822,
      decidedByUserId: "user-1",
    });

    expect(result).toEqual({ plan: false, question: false });
    expect(decideSessionPlanRequest).not.toHaveBeenCalled();
    expect(decideSessionQuestionRequest).not.toHaveBeenCalled();
  });

  // 決まった直後・期限切れに当たるのは普通に起きる。**そのときは待ちがもう無いので目的は達している**
  it("畳めなくても失敗にしない", async () => {
    planRequestFindFirst.mockResolvedValue({ id: "plan-1" });
    decideSessionPlanRequest.mockResolvedValue({ ok: false, rejection: "already_decided" });

    const result = await deferPendingSessionRequests({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2822,
      decidedByUserId: "user-1",
    });

    expect(result).toEqual({ plan: false, question: false });
  });
});

/**
 * 起動時のリセット（計画レビューの指摘2）。**pollerの巡回（`isRevivedSession`）では間に合わない**
 * ——動くのは次の一括報告で、`ALIVE`のまま立ち上がり直した行では一度も動かない。
 */
describe("resetSessionAnswerInApp", () => {
  it("そのセッションの行だけをOFFへ戻す", async () => {
    await resetSessionAnswerInApp({ host: "subpc", tmuxSessionName: "issue-deck-issue-2822" });

    expect(dispatchSessionUpdateMany).toHaveBeenCalledWith({
      where: { host: "subpc", tmuxSessionName: "issue-deck-issue-2822" },
      data: { answerInApp: false },
    });
  });
});
