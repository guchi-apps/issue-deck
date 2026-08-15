import { beforeEach, describe, expect, it, vi } from "vitest";

const addIssueLabels = vi.fn();
const removeIssueLabel = vi.fn();
const fetchRepositoryLabelNames = vi.fn();

vi.mock("@/lib/github/issues-api", () => ({
  addIssueLabels: (...args: unknown[]) => addIssueLabels(...args),
  removeIssueLabel: (...args: unknown[]) => removeIssueLabel(...args),
  fetchRepositoryLabelNames: (...args: unknown[]) => fetchRepositoryLabelNames(...args),
}));

const { addCheckUserWithReason, removeCheckUserWithReason } = await import(
  "@/lib/dispatch/check-user-labels"
);

const ALL_REASON_LABELS = new Set([
  "00.check-user",
  "01.check-plan",
  "01.check-input",
  "01.check-merge",
  "01.check-blocked",
  "01.check-answered",
]);

beforeEach(() => {
  addIssueLabels.mockReset();
  removeIssueLabel.mockReset();
  fetchRepositoryLabelNames.mockReset();
  removeIssueLabel.mockResolvedValue([]);
});

describe("addCheckUserWithReason", () => {
  it("00.check-userを先に単独で付け、続けて理由ラベルを付ける", async () => {
    addIssueLabels.mockResolvedValue(["00.check-user"]);
    fetchRepositoryLabelNames.mockResolvedValue(ALL_REASON_LABELS);

    await addCheckUserWithReason("guchi-apps", "issue-deck", 1, "token", "plan");

    expect(addIssueLabels).toHaveBeenNthCalledWith(1, "guchi-apps", "issue-deck", 1, "token", [
      "00.check-user",
    ]);
    expect(addIssueLabels).toHaveBeenNthCalledWith(2, "guchi-apps", "issue-deck", 1, "token", [
      "01.check-plan",
    ]);
  });

  it("理由ラベルがリポジトリに配られていなければ付けない（付与エンドポイントが勝手に作るのを防ぐ）", async () => {
    addIssueLabels.mockResolvedValue(["00.check-user"]);
    fetchRepositoryLabelNames.mockResolvedValue(new Set(["00.check-user"]));

    await addCheckUserWithReason("guchi-apps", "shopping-list", 2, "token", "input");

    expect(addIssueLabels).toHaveBeenCalledTimes(1);
    expect(removeIssueLabel).not.toHaveBeenCalled();
  });

  it("理由は常に1枚。既に付いている別の理由ラベル（旧名を含む）を外す", async () => {
    addIssueLabels.mockResolvedValue([
      "00.check-user",
      "01.check-input",
      "00.qa-answered",
      "11.local",
    ]);
    fetchRepositoryLabelNames.mockResolvedValue(ALL_REASON_LABELS);

    await addCheckUserWithReason("guchi-apps", "issue-deck", 3, "token", "blocked");

    const removed = removeIssueLabel.mock.calls.map((call) => call[4]);
    expect(removed.sort()).toEqual(["00.qa-answered", "01.check-input"]);
    // 理由ラベル以外は巻き込まない
    expect(removed).not.toContain("11.local");
  });

  it("ラベル一覧の取得に失敗しても、00.check-userの付与は巻き添えにしない", async () => {
    addIssueLabels.mockResolvedValue(["00.check-user"]);
    fetchRepositoryLabelNames.mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      addCheckUserWithReason("guchi-apps", "issue-deck", 4, "token", "plan"),
    ).resolves.toBeUndefined();

    expect(addIssueLabels).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe("removeCheckUserWithReason", () => {
  it("00.check-userを外し、残っている理由ラベルだけを続けて外す", async () => {
    removeIssueLabel.mockResolvedValueOnce(["01.check-plan", "21.plan-required"]);

    await removeCheckUserWithReason("guchi-apps", "issue-deck", 5, "token");

    expect(removeIssueLabel.mock.calls.map((call) => call[4])).toEqual([
      "00.check-user",
      "01.check-plan",
    ]);
  });

  it("00.check-userが既に外れていれば（404）何もしない", async () => {
    // 人が画面の承認ボタンで先に外した場合。その経路が理由ラベルも一緒に落としている
    removeIssueLabel.mockResolvedValueOnce(null);

    await removeCheckUserWithReason("guchi-apps", "issue-deck", 6, "token");

    expect(removeIssueLabel).toHaveBeenCalledTimes(1);
  });
});
