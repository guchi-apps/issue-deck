import { beforeEach, describe, expect, it, vi } from "vitest";

const findRequest = vi.fn();
const countRequests = vi.fn();
const findAppSetting = vi.fn();
const updateJob = vi.fn();
const decide = vi.fn();
const resolveCheckUser = vi.fn();
const createComment = vi.fn();
const pickByJev = vi.fn();
const findJobs = vi.fn();
const recordCodexDelivery = vi.fn();
const notifyCodex = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    sessionPlanRequest: {
      findFirst: (...a: unknown[]) => findRequest(...a),
      count: (...a: unknown[]) => countRequests(...a),
    },
    appSetting: { findUnique: (...a: unknown[]) => findAppSetting(...a) },
    dispatchJob: {
      update: (...a: unknown[]) => updateJob(...a),
      findMany: (...a: unknown[]) => findJobs(...a),
    },
  },
}));
vi.mock("@/lib/claude/plan-review-pick", () => ({
  pickPlanReviewAdoptionByJev: (...a: unknown[]) => pickByJev(...a),
}));
vi.mock("@/lib/dispatch/plan-requests", () => ({
  decideSessionPlanRequest: (...a: unknown[]) => decide(...a),
  recordSessionPlanCodexDelivery: (...a: unknown[]) => recordCodexDelivery(...a),
}));
vi.mock("@/lib/dispatch/codex-decision-notify", () => ({
  notifyCodexSessionDecision: (...a: unknown[]) => notifyCodex(...a),
}));
vi.mock("@/lib/dispatch/session-plan", () => ({
  resolveSessionPlanCheckUser: (...a: unknown[]) => resolveCheckUser(...a),
}));
vi.mock("@/lib/dispatch/installation-token", () => ({
  resolveInstallationToken: vi.fn(async () => "token"),
}));
vi.mock("@/lib/github/issues-api", () => ({
  createComment: (...a: unknown[]) => createComment(...a),
}));

const { autoReflectPlanReview, PLAN_REVIEW_AUTO_REFLECT_MARKER } = await import(
  "@/lib/dispatch/plan-review-auto-reflect"
);
const { PLAN_REVIEW_REFLECT_REQUEST_TEXT } = await import("@/lib/dispatch/session-plan-request");

const WITH_FINDINGS = [
  "## 計画レビュー（G1）",
  "",
  "**1. 見出し**",
  "- **指摘**: なにか",
  "- **根拠**: `a.ts:1`",
  "- **提案**: 直す",
  "",
  "<!-- supervisor:plan-review -->",
].join("\n");
const NO_FINDINGS = "## 計画レビュー（G1）\n\n指摘なし。\n\n<!-- supervisor:plan-review -->";
const UNPARSED = "## 計画レビュー（G1）\n\n自由記述だけの本文です。\n\n<!-- supervisor:plan-review -->";

const PLAN_CREATED_AT = new Date("2026-09-30T12:00:00Z");
const NEW_JOB = { jobId: "job-2", createdAt: new Date("2026-09-30T12:00:05Z") };
const OLD_JOB = { jobId: "job-1", createdAt: new Date("2026-09-30T11:50:00Z") };

const params = (commentBody: string, postedJob = NEW_JOB) => ({
  repositoryFullName: "guchi-apps/issue-deck",
  issueNumber: 3616,
  commentBody,
  postedJob,
});

describe("autoReflectPlanReview", () => {
  beforeEach(() => {
    for (const m of [
      findRequest,
      countRequests,
      findAppSetting,
      updateJob,
      decide,
      resolveCheckUser,
      createComment,
      pickByJev,
      findJobs,
      recordCodexDelivery,
      notifyCodex,
    ]) {
      m.mockReset();
    }
    // 最初の`findFirst`は今の計画待ち、2回目は「最後に人が決めた計画待ち」（無し）
    findRequest.mockImplementation(async (args: { where: { status?: string } }) =>
      args.where.status === "WAITING" ? { id: "req-1", createdAt: PLAN_CREATED_AT } : null,
    );
    findAppSetting.mockResolvedValue({ planReviewAutoReflectEnabled: true, planReviewAutoReflectMaxRounds: 5 });
    // 既定は「このIssueで届いたレビューは初回の1件だけ」
    findJobs.mockResolvedValue([{ id: "job-2", createdAt: NEW_JOB.createdAt, requestedByUserId: null }]);
    countRequests.mockResolvedValue(0);
    pickByJev.mockResolvedValue(true);
    decide.mockResolvedValue({ ok: true });
    notifyCodex.mockResolvedValue({ ok: false, reason: "not_codex", message: "" });
  });

  it("Jevが採用と判断した指摘は、画面の一括ボタンと同じ固定文面で修正を送り、後処理まで行う", async () => {
    const result = await autoReflectPlanReview(params(WITH_FINDINGS));
    expect(result).toEqual({ reflected: true });
    expect(pickByJev).toHaveBeenCalledWith(WITH_FINDINGS);
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "req-1",
        decision: "revise",
        revisionText: PLAN_REVIEW_REFLECT_REQUEST_TEXT,
        decidedByUserId: null,
      }),
    );
    const body = createComment.mock.calls[0][4].body as string;
    expect(body).toContain(PLAN_REVIEW_AUTO_REFLECT_MARKER);
    expect(body).not.toContain("plan-reviser");
    expect(resolveCheckUser).toHaveBeenCalled();
  });

  it("Codex実装セッションへは既存の固定継続指示を積み、配送結果を記録する", async () => {
    notifyCodex.mockResolvedValue({ ok: true, jobId: "instruction-1" });

    await expect(autoReflectPlanReview(params(WITH_FINDINGS))).resolves.toEqual({ reflected: true });

    expect(notifyCodex).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 3616,
      kind: "plan-revision",
      requestedByUserId: null,
    });
    expect(recordCodexDelivery).toHaveBeenCalledWith({
      id: "req-1",
      queued: true,
      summary: null,
    });
  });

  it("Codexへの配送を積めない場合も、既存の復旧導線向けに理由を記録する", async () => {
    notifyCodex.mockResolvedValue({
      ok: false,
      reason: "not_alive",
      message: "Codexのセッションが動いていません。",
    });

    await expect(autoReflectPlanReview(params(WITH_FINDINGS))).resolves.toEqual({ reflected: true });

    expect(recordCodexDelivery).toHaveBeenCalledWith({
      id: "req-1",
      queued: false,
      summary: "Codexのセッションが動いていません。",
    });
  });

  it("Codexへの配送処理が例外になっても、自動反映済みの判断は失わせない", async () => {
    notifyCodex.mockRejectedValue(new Error("queue unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(autoReflectPlanReview(params(WITH_FINDINGS))).resolves.toEqual({ reflected: true });

    expect(recordCodexDelivery).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("書式が崩れて指摘に分けられないレビューも、Jevが採用すれば一括の依頼文で反映する", async () => {
    expect(await autoReflectPlanReview(params(UNPARSED))).toEqual({ reflected: true });
  });

  it("どの終わり方でも、最後にジョブへ採否の確定を書く（保留を外す）", async () => {
    const cases: [string, () => Promise<unknown>][] = [
      ["反映", () => autoReflectPlanReview(params(WITH_FINDINGS))],
      ["指摘なし", () => autoReflectPlanReview(params(NO_FINDINGS))],
      [
        "Jevが不採用",
        async () => {
          pickByJev.mockResolvedValueOnce(false);
          return autoReflectPlanReview(params(WITH_FINDINGS));
        },
      ],
    ];
    for (const [, run] of cases) {
      updateJob.mockReset();
      await run();
      expect(updateJob).toHaveBeenCalledWith({
        where: { id: "job-2" },
        data: { planReviewDecidedAt: expect.any(Date) },
      });
    }
  });

  it("レビュー以外のコメントは何もしない（採否の確定も書かない）", async () => {
    expect(await autoReflectPlanReview(params("ふつうのコメント"))).toEqual({
      reflected: false,
      reason: "not_review",
    });
    expect(updateJob).not.toHaveBeenCalled();
  });

  it("指摘なしのレビューは反映しない", async () => {
    expect(await autoReflectPlanReview(params(NO_FINDINGS))).toEqual({
      reflected: false,
      reason: "no_findings",
    });
    expect(decide).not.toHaveBeenCalled();
    expect(pickByJev).not.toHaveBeenCalled();
  });

  it("人が決める判断を含むレビューは、Jevに聞かず反映しない（#3660）", async () => {
    const withDecision = `${WITH_FINDINGS}\n\n**判断1. どちらにするか**\n\n- **論点**: 方針\n- **選択肢**:\n  - A. 案A\n  - B. 案B\n- **推奨**: A\n`;
    expect(await autoReflectPlanReview(params(withDecision))).toEqual({
      reflected: false,
      reason: "has_decisions",
    });
    expect(pickByJev).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(updateJob).toHaveBeenCalled();
  });

  it("Jevが採用しない・答えが取れないときは反映しない（通知へ倒す）", async () => {
    pickByJev.mockResolvedValueOnce(false);
    expect(await autoReflectPlanReview(params(WITH_FINDINGS))).toEqual({
      reflected: false,
      reason: "not_adopted",
    });
    pickByJev.mockResolvedValueOnce(null);
    expect(await autoReflectPlanReview(params(WITH_FINDINGS))).toEqual({
      reflected: false,
      reason: "not_adopted",
    });
    expect(decide).not.toHaveBeenCalled();
  });

  it("設定がOFFなら、Jevに聞かず反映しない", async () => {
    findAppSetting.mockResolvedValue({ planReviewAutoReflectEnabled: false, planReviewAutoReflectMaxRounds: 5 });
    expect(await autoReflectPlanReview(params(WITH_FINDINGS))).toEqual({
      reflected: false,
      reason: "disabled",
    });
    expect(pickByJev).not.toHaveBeenCalled();
  });

  it("前の計画へのレビューが遅れて届いたときは、記録だけして反映しない", async () => {
    expect(await autoReflectPlanReview(params(WITH_FINDINGS, OLD_JOB))).toEqual({
      reflected: false,
      reason: "stale_review",
    });
    expect(pickByJev).not.toHaveBeenCalled();
    expect(updateJob).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { planReviewDecidedAt: expect.any(Date) },
    });
  });

  it("届いたレビューのジョブを特定できなければ反映しない", async () => {
    expect(
      await autoReflectPlanReview({ ...params(WITH_FINDINGS), postedJob: null }),
    ).toEqual({ reflected: false, reason: "no_job" });
    expect(updateJob).not.toHaveBeenCalled();
  });

  it("計画待ちが無い・連続回数が上限・取り合いに負けたときは反映しない", async () => {
    findRequest.mockResolvedValueOnce(null);
    expect((await autoReflectPlanReview(params(WITH_FINDINGS))).reflected).toBe(false);

    countRequests.mockResolvedValueOnce(1);
    expect(await autoReflectPlanReview(params(WITH_FINDINGS))).toEqual({
      reflected: false,
      reason: "limit",
    });

    decide.mockResolvedValueOnce({ ok: false, rejection: "already_decided" });
    expect(await autoReflectPlanReview(params(WITH_FINDINGS))).toEqual({
      reflected: false,
      reason: "lost_race",
    });
    expect(createComment).not.toHaveBeenCalled();
  });

  it("旧設定の上限5でも、自動反映は連続1回までで、人が最後に決めた計画待ちより後だけを数える", async () => {
    const humanDecidedAt = new Date("2026-09-30T11:00:00Z");
    findRequest.mockImplementation(async (args: { where: { status?: string; decidedByUserId?: unknown } }) =>
      args.where.status === "WAITING"
        ? { id: "req-1", createdAt: PLAN_CREATED_AT }
        : { decidedAt: humanDecidedAt },
    );
    countRequests.mockResolvedValue(0);

    expect(await autoReflectPlanReview(params(WITH_FINDINGS))).toEqual({ reflected: true });
    expect(countRequests).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: "REVISION_REQUESTED",
        decidedByUserId: null,
        decidedAt: { gt: humanDecidedAt },
      }),
    });

    countRequests.mockResolvedValue(1);
    expect(await autoReflectPlanReview(params(WITH_FINDINGS))).toEqual({
      reflected: false,
      reason: "limit",
    });
  });

  const NOTE_ONLY = [
    "## 計画レビュー（G1）",
    "",
    "**1. 実装時に直す**",
    "- **区分**: 実装時対応の補足",
    "- **指摘**: なにか",
    "- **根拠**: `a.ts:1`",
    "- **提案**: 直す",
    "",
    "<!-- supervisor:plan-review -->",
  ].join("\n");

  it("実装時対応の補足だけのレビューは、Jevに聞かず反映しない（自動修正ループを起こさない）", async () => {
    expect(await autoReflectPlanReview(params(NOTE_ONLY))).toEqual({
      reflected: false,
      reason: "no_blocking",
    });
    expect(pickByJev).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(updateJob).toHaveBeenCalled();
  });

  it("解消確認（2回目のレビュー）で重大な問題が残れば、反映せず未解消点をまとめて人へ引き継ぐ", async () => {
    findJobs.mockResolvedValue([
      { id: "job-1", createdAt: OLD_JOB.createdAt, requestedByUserId: null },
      { id: "job-2", createdAt: NEW_JOB.createdAt, requestedByUserId: null },
    ]);
    expect(await autoReflectPlanReview(params(WITH_FINDINGS))).toEqual({
      reflected: false,
      reason: "unresolved",
    });
    expect(pickByJev).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    const body = createComment.mock.calls[0][4].body as string;
    expect(body).toContain("issue-deck:plan-review-unresolved");
    expect(body).toContain("1. 見出し");
    expect(updateJob).toHaveBeenCalled();
  });

  it("解消確認で補足だけ・指摘なしなら、何も投稿せず終える", async () => {
    findJobs.mockResolvedValue([
      { id: "job-1", createdAt: OLD_JOB.createdAt, requestedByUserId: null },
      { id: "job-2", createdAt: NEW_JOB.createdAt, requestedByUserId: null },
    ]);
    expect(await autoReflectPlanReview(params(NOTE_ONLY))).toEqual({
      reflected: false,
      reason: "no_blocking",
    });
    expect(createComment).not.toHaveBeenCalled();
  });

  it("人が手動で積んだレビューは新しい初回として数え直し、自動反映の対象になる", async () => {
    findJobs.mockResolvedValue([
      { id: "job-0", createdAt: new Date("2026-09-30T10:00:00Z"), requestedByUserId: null },
      { id: "job-1", createdAt: OLD_JOB.createdAt, requestedByUserId: null },
      { id: "job-2", createdAt: NEW_JOB.createdAt, requestedByUserId: "user-1" },
    ]);
    expect(await autoReflectPlanReview(params(WITH_FINDINGS))).toEqual({ reflected: true });
  });
});
