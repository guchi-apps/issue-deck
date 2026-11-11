import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveInstallationToken: vi.fn(),
  removeCheckUserWithReason: vi.fn(),
  fetchPullRequestsForHead: vi.fn(),
  rerunPullRequestAutoMerge: vi.fn(),
}));

vi.mock("@/lib/dispatch/installation-token", () => ({ resolveInstallationToken: mocks.resolveInstallationToken }));
vi.mock("@/lib/dispatch/check-user-labels", () => ({
  addCheckUserWithReason: vi.fn(),
  removeCheckUserWithReason: mocks.removeCheckUserWithReason,
}));
vi.mock("@/lib/github/issues-api", () => ({ createComment: vi.fn() }));
vi.mock("@/lib/github/pull-requests-api", () => ({ fetchPullRequestsForHead: mocks.fetchPullRequestsForHead }));
vi.mock("@/lib/github/pull-request-auto-merge-rerun", () => ({
  rerunPullRequestAutoMerge: mocks.rerunPullRequestAutoMerge,
}));

const { resolveInterruptedSession } = await import("@/lib/dispatch/session-escalation");

const target = { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 5318 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveInstallationToken.mockResolvedValue("token");
  mocks.removeCheckUserWithReason.mockResolvedValue(true);
  mocks.fetchPullRequestsForHead.mockResolvedValue([]);
  mocks.rerunPullRequestAutoMerge.mockResolvedValue({ ok: true, runId: 1, jobId: 2 });
});

/**
 * #5326。停滞の引き上げを受けたセッションが動き出したら、引き上げの確認待ちを外し、
 * 先に作られていたPRの自動マージの判定をやり直す（#5322・#5324の形）。
 */
describe("resolveInterruptedSession", () => {
  it("外すのは理由が01.check-blockedの確認待ちだけ", async () => {
    await resolveInterruptedSession(target);
    expect(mocks.removeCheckUserWithReason).toHaveBeenCalledWith("guchi-apps", "issue-deck", 5318, "token", {
      onlyReasons: ["blocked"],
    });
  });

  it("PRがまだ無ければ、外すだけで終わる", async () => {
    expect(await resolveInterruptedSession(target)).toEqual({ removed: true, rerunPullRequest: null });
    expect(mocks.fetchPullRequestsForHead).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      "develop",
      "issue-5318",
      "open",
      "token",
    );
    expect(mocks.rerunPullRequestAutoMerge).not.toHaveBeenCalled();
  });

  it("先に作られていたPRがあれば、auto-mergeジョブをやり直す", async () => {
    mocks.fetchPullRequestsForHead.mockResolvedValue([{ number: 5322 }]);
    expect(await resolveInterruptedSession(target)).toEqual({ removed: true, rerunPullRequest: 5322 });
    expect(mocks.rerunPullRequestAutoMerge).toHaveBeenCalledWith({
      owner: "guchi-apps",
      repo: "issue-deck",
      number: 5322,
      token: "token",
    });
  });

  it("外さなかった（別の理由の確認待ち）ときはPRに触らない", async () => {
    mocks.removeCheckUserWithReason.mockResolvedValue(false);
    expect(await resolveInterruptedSession(target)).toEqual({ removed: false, rerunPullRequest: null });
    expect(mocks.fetchPullRequestsForHead).not.toHaveBeenCalled();
  });

  it("やり直しが失敗しても例外を投げない（外したことは返す）", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.fetchPullRequestsForHead.mockResolvedValue([{ number: 5322 }]);
    mocks.rerunPullRequestAutoMerge.mockRejectedValue(new Error("boom"));
    expect(await resolveInterruptedSession(target)).toEqual({ removed: true, rerunPullRequest: null });
    error.mockRestore();
  });
});
