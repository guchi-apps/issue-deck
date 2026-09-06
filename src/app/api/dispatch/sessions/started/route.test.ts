import { beforeEach, describe, expect, it, vi } from "vitest";

const postSessionStartedComment = vi.fn();
const resetSessionAnswerInApp = vi.fn();

vi.mock("@/lib/dispatch/session-start", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dispatch/session-start")>();
  return {
    ...actual,
    get postSessionStartedComment() {
      return postSessionStartedComment;
    },
  };
});

// 「アプリで答える」（#2822）を起動時に既定へ戻す。DBを引かずに、呼ばれ方だけを確かめる
vi.mock("@/lib/dispatch/session-answer-mode", () => ({
  get resetSessionAnswerInApp() {
    return resetSessionAnswerInApp;
  },
}));

const { POST } = await import("./route");

function postRequest(body: unknown, authorization?: string) {
  return new Request("http://localhost/api/dispatch/sessions/started", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

  const validBody = {
  repository: "guchi-apps/issue-deck",
  issue: 1119,
  host: "subpc",
    tmuxSessionName: "issue-deck-issue-1119",
    agent: "codex",
    model: "gpt-5-codex",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISPATCH_SECRET = "secret-value";
  postSessionStartedComment.mockResolvedValue(true);
  resetSessionAnswerInApp.mockResolvedValue(undefined);
});

describe("POST /api/dispatch/sessions/started", () => {
  it("DISPATCH_SECRET未設定なら503（値の不一致と区別できるようにする）", async () => {
    delete process.env.DISPATCH_SECRET;
    const res = await POST(postRequest(validBody, "Bearer secret-value"));
    expect(res.status).toBe(503);
    expect(postSessionStartedComment).not.toHaveBeenCalled();
  });

  it("シークレットが一致しなければ401", async () => {
    const res = await POST(postRequest(validBody, "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(postSessionStartedComment).not.toHaveBeenCalled();
  });

  it("宛先が不正なら400", async () => {
    const res = await POST(
      postRequest({ ...validBody, repository: "issue-deck" }, "Bearer secret-value"),
    );
    expect(res.status).toBe(400);
    expect(postSessionStartedComment).not.toHaveBeenCalled();
  });

  /**
   * どちらも本文へそのまま埋め、実行の様子を見に行く唯一の手掛かりになる。欠けた受付コメントを
   * 出しても「押したのに何も起きていない」の解消にならない。
   */
  it("ホスト名・tmuxセッション名が欠けていれば400", async () => {
    for (const body of [
      { ...validBody, host: undefined },
      { ...validBody, tmuxSessionName: "" },
      { ...validBody, host: "評価用ホスト" },
    ]) {
      const res = await POST(postRequest(body, "Bearer secret-value"));
      expect(res.status).toBe(400);
    }
    expect(postSessionStartedComment).not.toHaveBeenCalled();
  });

  it("検証済みの値をそのまま渡す", async () => {
    const res = await POST(postRequest(validBody, "Bearer secret-value"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, posted: true });
    expect(postSessionStartedComment).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1119,
      hostName: "subpc",
      tmuxSessionName: "issue-deck-issue-1119",
      agent: "codex",
      model: "gpt-5-codex",
    });
  });

  // 呼び出し側（起動スクリプト）は再送の判断ができる相手ではない。非0を返しても起動ログに
  // エラーが増えるだけになる
  it("投稿できなくても200で返す", async () => {
    postSessionStartedComment.mockResolvedValue(false);
    const res = await POST(postRequest(validBody, "Bearer secret-value"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, posted: false });
  });
});

/**
 * 起動時に「アプリで答える」を既定へ戻す（#2822・計画レビューの指摘2）。
 *
 * pollerの巡回（`isRevivedSession`）では間に合わない——動くのは次の一括報告（既定60秒ごと）で、
 * `ALIVE`のまま立ち上がり直した行では一度も動かない。手作業セッションは起動から数秒で
 * `AskUserQuestion`を出すため、ここで戻さないと前のセッションのONがそのまま効く。
 */
describe("アプリで答えるのリセット（#2822）", () => {
  it("受付コメントより先に、そのセッションの行を既定へ戻す", async () => {
    const res = await POST(postRequest(validBody, "Bearer secret-value"));

    expect(res.status).toBe(200);
    expect(resetSessionAnswerInApp).toHaveBeenCalledWith({
      host: "subpc",
      tmuxSessionName: "issue-deck-issue-1119",
    });
  });

  // 記録が残らない方が損失が大きい。戻せなくても受付コメントは投稿する
  it("戻せなくても受付コメントは投稿する", async () => {
    resetSessionAnswerInApp.mockRejectedValue(new Error("db down"));

    const res = await POST(postRequest(validBody, "Bearer secret-value"));

    expect(res.status).toBe(200);
    expect(postSessionStartedComment).toHaveBeenCalledTimes(1);
  });
});
