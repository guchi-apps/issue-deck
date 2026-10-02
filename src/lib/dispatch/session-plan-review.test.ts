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
const listCountedPlanReviewJobs = vi.fn();

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

vi.mock("@/lib/dispatch/plan-review-kind", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dispatch/plan-review-kind")>()),
  listCountedPlanReviewJobs: (...args: unknown[]) => listCountedPlanReviewJobs(...args),
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
  listCountedPlanReviewJobs.mockReset().mockResolvedValue([]);
});

describe("postSessionPlan の計画レビュー起動", () => {
  it("21.plan-requiredが付いた計画を投稿したら、そのホストへ計画レビューを積む", async () => {
    await expect(postSessionPlan(PLAN)).resolves.toBe(true);

    expect(enqueuePlanReviewJob).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1855,
      hostName: "subpc",
      agent: undefined,
      // 人が押したわけではないので、積んだユーザーは残らない
      requestedByUserId: null,
    });
  });

  it("Codexが投稿した計画はCodexのレビューを積む", async () => {
    await expect(postSessionPlan({ ...PLAN, agent: "codex" })).resolves.toBe(true);

    expect(enqueuePlanReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "codex" }),
    );
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

  const commentBodies = () => createComment.mock.calls.map((call) => String(call[4].body));

  it("判定不能な計画は理由付きで初回レビューを積み、初回の印を残す", async () => {
    await postSessionPlan(PLAN);

    expect(enqueuePlanReviewJob).toHaveBeenCalledTimes(1);
    expect(commentBodies().some((body) => body.includes("plan-review-kind:initial"))).toBe(true);
  });

  it("表示・文言だけの小さな変更は、レビューを積まず省略の理由を残す", async () => {
    const plan = "## 要約\n**ボタンの文言を修正する**\n\n## 変更するファイル\n- `src/components/dashboard/foo.tsx`: 文言を直す";
    await expect(postSessionPlan({ ...PLAN, plan })).resolves.toBe(true);

    expect(enqueuePlanReviewJob).not.toHaveBeenCalled();
    expect(commentBodies().some((body) => body.includes("plan-review-skipped"))).toBe(true);
  });

  it("小さな変更でも認証に関わる計画は初回レビューを積む", async () => {
    const plan = "## 要約\n**文言を修正する**\n認証の権限判定にも触る\n\n## 変更するファイル\n- `src/components/dashboard/foo.tsx`: 文言を直す";
    await postSessionPlan({ ...PLAN, plan });

    expect(enqueuePlanReviewJob).toHaveBeenCalledTimes(1);
  });

  it("初回が済んだ後の計画（人の修正でも自動反映でも）は解消確認を積む", async () => {
    listCountedPlanReviewJobs.mockResolvedValue([
      { id: "j1", createdAt: new Date("2026-10-01T00:00:00Z"), requestedByUserId: null },
    ]);
    await postSessionPlan(PLAN);

    expect(enqueuePlanReviewJob).toHaveBeenCalledTimes(1);
    expect(commentBodies().some((body) => body.includes("plan-review-kind:resolve"))).toBe(true);
  });

  it("解消確認まで済んでいれば、全体レビューを積まず人へ引き継ぐ", async () => {
    listCountedPlanReviewJobs.mockResolvedValue([
      { id: "j1", createdAt: new Date("2026-10-01T00:00:00Z"), requestedByUserId: null },
      { id: "j2", createdAt: new Date("2026-10-01T01:00:00Z"), requestedByUserId: null },
    ]);
    await postSessionPlan(PLAN);

    expect(enqueuePlanReviewJob).not.toHaveBeenCalled();
    expect(commentBodies().some((body) => body.includes("plan-review-limit"))).toBe(true);
  });
});
