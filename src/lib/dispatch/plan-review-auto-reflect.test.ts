import { beforeEach, describe, expect, it, vi } from "vitest";

const findRequest = vi.fn();
const findJob = vi.fn();
const countReflected = vi.fn();
const decide = vi.fn();
const resolveCheckUser = vi.fn();
const createComment = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    sessionPlanRequest: {
      findFirst: (...a: unknown[]) => findRequest(...a),
      count: (...a: unknown[]) => countReflected(...a),
    },
    dispatchJob: { findFirst: (...a: unknown[]) => findJob(...a) },
  },
}));
vi.mock("@/lib/dispatch/plan-requests", () => ({
  decideSessionPlanRequest: (...a: unknown[]) => decide(...a),
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

const params = (commentBody: string) => ({
  repositoryFullName: "guchi-apps/issue-deck",
  issueNumber: 3616,
  commentBody,
});

describe("autoReflectPlanReview", () => {
  beforeEach(() => {
    for (const m of [findRequest, findJob, countReflected, decide, resolveCheckUser, createComment]) {
      m.mockReset();
    }
    findRequest.mockResolvedValue({ id: "req-1" });
    findJob.mockResolvedValue({ agent: "claude" });
    countReflected.mockResolvedValue(0);
    decide.mockResolvedValue({ ok: true });
  });

  it("指摘ありなら、画面の一括ボタンと同じ固定文面で修正を送り、後処理まで行う", async () => {
    const result = await autoReflectPlanReview(params(WITH_FINDINGS));
    expect(result).toEqual({ reflected: true });
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

  it("書式が崩れて指摘に分けられないレビューも、一括の依頼文で反映する", async () => {
    expect(await autoReflectPlanReview(params(UNPARSED))).toEqual({ reflected: true });
  });

  it("指摘なしのレビューは反映しない", async () => {
    expect(await autoReflectPlanReview(params(NO_FINDINGS))).toEqual({
      reflected: false,
      reason: "no_findings",
    });
    expect(decide).not.toHaveBeenCalled();
  });

  it("レビュー以外のコメントは何もしない", async () => {
    expect(await autoReflectPlanReview(params("ふつうのコメント"))).toEqual({
      reflected: false,
      reason: "not_review",
    });
  });

  it("計画待ちが無い・Codex・回数上限・取り合いに負けたときは反映しない", async () => {
    findRequest.mockResolvedValueOnce(null);
    expect((await autoReflectPlanReview(params(WITH_FINDINGS))).reflected).toBe(false);

    findJob.mockResolvedValueOnce({ agent: "codex" });
    expect(await autoReflectPlanReview(params(WITH_FINDINGS))).toEqual({
      reflected: false,
      reason: "not_claude",
    });

    countReflected.mockResolvedValueOnce(1);
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
});
