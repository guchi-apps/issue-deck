import { beforeEach, describe, expect, it, vi } from "vitest";

const reportProgressStatus = vi.fn();

vi.mock("@/lib/github/report-progress", () => ({
  get reportProgressStatus() {
    return reportProgressStatus;
  },
}));

const { advanceSessionPlanProgress } = await import("@/lib/dispatch/session-plan-progress");

const target = { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 3213 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("advanceSessionPlanProgress（#3213）", () => {
  // Planningにいるものだけを動かす。再開・差し戻しで進んでいるIssueを巻き戻さない
  it("Planningにいるときだけ実装へ進める", async () => {
    reportProgressStatus.mockResolvedValue({ applied: true });
    await expect(advanceSessionPlanProgress(target)).resolves.toBe(true);
    expect(reportProgressStatus).toHaveBeenCalledWith({
      ...target,
      status: "implementation",
      onlyFrom: ["planning"],
    });
  });

  it("進められなかったとき（別の段・盤面に無い）はfalse", async () => {
    reportProgressStatus.mockResolvedValue({ applied: false, reason: "not_in_project" });
    await expect(advanceSessionPlanProgress(target)).resolves.toBe(false);
  });

  // 返事はもうDBに入ってセッションへ届く。ここで投げると画面に失敗が返り、押し直しになる
  it("報告が投げても例外にしない", async () => {
    reportProgressStatus.mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(advanceSessionPlanProgress(target)).resolves.toBe(false);
    error.mockRestore();
  });
});
