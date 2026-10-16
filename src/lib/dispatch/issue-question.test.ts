import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, enqueueQuestion, enqueueInstruction, resolveHost } = vi.hoisted(() => ({
  state: vi.fn(), enqueueQuestion: vi.fn(), enqueueInstruction: vi.fn(), resolveHost: vi.fn(),
}));
vi.mock("@/lib/dispatch/jobs", () => ({
  listDispatchState: state, enqueueCrossRepoQuestionJob: enqueueQuestion,
  enqueueSessionControlJob: enqueueInstruction,
}));
vi.mock("@/lib/dispatch/dispatch-job", () => ({ resolveDefaultCrossRepoQuestionHost: resolveHost }));
import { prepareIssueQuestion } from "./issue-question";

const target = { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 4680, requestedByUserId: "user" };
describe("prepareIssueQuestion", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.mockResolvedValue({ sessions: [], hosts: [] });
    resolveHost.mockReturnValue("subpc");
    enqueueQuestion.mockResolvedValue({ ok: true });
    enqueueInstruction.mockResolvedValue({ ok: true });
  });
  it("投稿前には起動せず、投稿成功後だけ既存の質問ジョブを積む", async () => {
    const question = await prepareIssueQuestion(target);
    expect(enqueueQuestion).not.toHaveBeenCalled();
    if (!("send" in question)) throw new Error("host expected");
    expect(await question.send()).toBeNull();
    expect(enqueueQuestion).toHaveBeenCalledWith({ ...target, hostName: "subpc" });
    expect(enqueueInstruction).not.toHaveBeenCalled();
  });
  it("ホストが無ければ質問保存前に理由を返す", async () => {
    resolveHost.mockReturnValue(null);
    expect(await prepareIssueQuestion(target)).toEqual({ error: expect.stringContaining("ホストがありません") });
    expect(enqueueQuestion).not.toHaveBeenCalled();
  });
  it("対象Issueの生存セッションへ読み取り専用の回答依頼を送る", async () => {
    state.mockResolvedValue({ sessions: [{ ...target, state: "ALIVE", host: "mac" }], hosts: [] });
    const question = await prepareIssueQuestion(target);
    if (!("send" in question)) throw new Error("session expected");
    await question.send();
    expect(enqueueInstruction).toHaveBeenCalledWith({
      ...target, hostName: "mac", kind: "INSTRUCTION", recovery: false,
      instruction: expect.stringContaining("コードを変更せず回答"),
    });
    expect(enqueueQuestion).not.toHaveBeenCalled();
  });
  it("終了済みや別Issueのセッションは転送先にしない", async () => {
    state.mockResolvedValue({ sessions: [
      { ...target, state: "EXITED", host: "mac" },
      { ...target, issueNumber: 1, state: "ALIVE", host: "mac" },
    ], hosts: [] });
    const question = await prepareIssueQuestion(target);
    if (!("send" in question)) throw new Error("host expected");
    await question.send();
    expect(enqueueInstruction).not.toHaveBeenCalled();
    expect(enqueueQuestion).toHaveBeenCalled();
  });
  it("投稿後に起動が拒否されたら、成功扱いせず理由を返す", async () => {
    enqueueQuestion.mockResolvedValue({ ok: false, message: "ホストがオフラインです" });
    const question = await prepareIssueQuestion(target);
    if (!("send" in question)) throw new Error("host expected");
    expect(await question.send()).toBe("ホストがオフラインです");
  });
});
