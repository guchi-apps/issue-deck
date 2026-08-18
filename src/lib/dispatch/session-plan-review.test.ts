import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 計画コメントの投稿を契機に計画レビュー（G1）を積む経路（#1855）。
 *
 * `session-plan.test.ts`とはファイルを分けてある。あちらは本文の組み立て（純粋関数）だけを見る
 * ためモックを1つも持たず、こちらはGitHubへの投稿とジョブ投入をすべて差し替える必要がある。
 */
const createComment = vi.fn();
const addCheckUserWithReason = vi.fn();
const removeCheckUserWithReason = vi.fn();
const resolveInstallationToken = vi.fn();
const enqueuePlanReviewJob = vi.fn();

vi.mock("@/lib/github/issues-api", () => ({
  createComment: (...args: unknown[]) => createComment(...args),
}));
vi.mock("@/lib/dispatch/check-user-labels", () => ({
  addCheckUserWithReason: (...args: unknown[]) => addCheckUserWithReason(...args),
  removeCheckUserWithReason: (...args: unknown[]) => removeCheckUserWithReason(...args),
}));
vi.mock("@/lib/dispatch/installation-token", () => ({
  resolveInstallationToken: (...args: unknown[]) => resolveInstallationToken(...args),
}));
vi.mock("@/lib/dispatch/jobs", () => ({
  enqueuePlanReviewJob: (...args: unknown[]) => enqueuePlanReviewJob(...args),
}));

const { postSessionPlan } = await import("@/lib/dispatch/session-plan");

const PLAN = {
  repositoryFullName: "guchi-apps/issue-deck",
  issueNumber: 1855,
  plan: "## 要約\nあれをする",
  remoteControlUrl: null,
  planBaseSha: null,
  hostName: "subpc",
};

beforeEach(() => {
  createComment.mockReset().mockResolvedValue({ id: 1 });
  addCheckUserWithReason.mockReset().mockResolvedValue(["00.check-user", "21.plan-required"]);
  resolveInstallationToken.mockReset().mockResolvedValue("token");
  enqueuePlanReviewJob.mockReset().mockResolvedValue({ ok: true, job: { id: "job1" } });
});

describe("postSessionPlan の計画レビュー起動", () => {
  it("21.plan-requiredが付いた計画を投稿したら、そのホストへ計画レビューを積む", async () => {
    await expect(postSessionPlan(PLAN)).resolves.toBe(true);

    expect(enqueuePlanReviewJob).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1855,
      hostName: "subpc",
      // 人が押したわけではないので、積んだユーザーは残らない
      requestedByUserId: null,
    });
  });

  /**
   * G1が守る範囲は無人実行（`mode=plan`）と同じで、`21.plan-required`が付いたIssueの計画。
   * ad hocにPlan modeへ入っただけの計画まで拾うと、レビュー1本ぶんのコストが予定外に増える。
   */
  it("21.plan-requiredが付いていなければ積まない", async () => {
    addCheckUserWithReason.mockResolvedValue(["00.check-user", "01.check-plan"]);

    await expect(postSessionPlan(PLAN)).resolves.toBe(true);

    expect(enqueuePlanReviewJob).not.toHaveBeenCalled();
  });

  /** ラベルを読めなかった（GitHubの応答が想定外）ときは積まない側へ倒す */
  it("ラベルが取れなければ積まない", async () => {
    addCheckUserWithReason.mockResolvedValue(null);

    await expect(postSessionPlan(PLAN)).resolves.toBe(true);

    expect(enqueuePlanReviewJob).not.toHaveBeenCalled();
  });

  /** 起こす先はそのセッションが動いているホスト。分からなければ積み先が決まらない */
  it("ホスト名が分からなければ積まない", async () => {
    await expect(postSessionPlan({ ...PLAN, hostName: null })).resolves.toBe(true);

    expect(enqueuePlanReviewJob).not.toHaveBeenCalled();
  });

  /**
   * **計画が実際に投稿された回だけ起こす**（無人側の`plan_posted`と同じ条件）。
   * 投稿が失敗しているのにレビューを走らせると、レビューの対象そのものが無い。
   */
  it("コメントの投稿に失敗したら積まない", async () => {
    createComment.mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(postSessionPlan(PLAN)).resolves.toBe(false);

    expect(enqueuePlanReviewJob).not.toHaveBeenCalled();
    error.mockRestore();
  });

  /**
   * 断られること自体は異常ではない（pollerが未対応・同じ計画のレビューが既にある）。
   * **計画の投稿は成功として扱う** — 人は画面の「計画をレビュー」から起こし直せる。
   */
  it("ジョブを積めなくても計画の投稿は成功として返す", async () => {
    enqueuePlanReviewJob.mockResolvedValue({
      ok: false,
      rejection: "plan_review_unsupported",
      message: "…",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(postSessionPlan(PLAN)).resolves.toBe(true);

    expect(createComment).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it("ジョブ投入が例外で落ちても計画の投稿は成功として返す", async () => {
    enqueuePlanReviewJob.mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(postSessionPlan(PLAN)).resolves.toBe(true);

    error.mockRestore();
  });
});
