import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearLabelsOnIssueClose } from "@/lib/github/issue-close-cleanup";

const removeIssueLabel = vi.fn();

vi.mock("@/lib/github/issues-api", () => ({
  get removeIssueLabel() {
    return removeIssueLabel;
  },
}));

describe("clearLabelsOnIssueClose", () => {
  beforeEach(() => {
    removeIssueLabel.mockReset().mockResolvedValue([]);
  });

  const params = {
    owner: "guchi-apps",
    repo: "issue-deck",
    issueNumber: 2178,
    token: "token",
  };

  it("付いている対象ラベルだけを外す", async () => {
    const removed = await clearLabelsOnIssueClose({
      ...params,
      currentLabelNames: ["50.feature", "11.local", "00.check-user", "01.check-plan"],
    });

    expect(removed).toEqual(["11.local", "00.check-user", "01.check-plan"]);
    expect(removeIssueLabel).toHaveBeenCalledTimes(3);
    expect(removeIssueLabel).not.toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      2178,
      "token",
      "50.feature",
    );
  });

  it("対象ラベルが1枚も付いていなければGitHubへ出て行かない", async () => {
    const removed = await clearLabelsOnIssueClose({
      ...params,
      currentLabelNames: ["30.bug", "21.plan-required"],
    });

    expect(removed).toEqual([]);
    expect(removeIssueLabel).not.toHaveBeenCalled();
  });

  it("1枚外せなくても投げず、残りは外して外せたぶんだけ返す", async () => {
    removeIssueLabel.mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const removed = await clearLabelsOnIssueClose({
      ...params,
      currentLabelNames: ["00.check-user", "11.local"],
    });

    expect(removed).toEqual(["11.local"]);
    expect(removeIssueLabel).toHaveBeenCalledTimes(2);
  });
});
