import { beforeEach, describe, expect, it, vi } from "vitest";

const addIssueLabels = vi.fn();
const removeIssueLabel = vi.fn();
const fetchRepositoryLabelNames = vi.fn();
const fetchIssueLabelNames = vi.fn();

vi.mock("@/lib/github/issues-api", () => ({
  addIssueLabels: (...args: unknown[]) => addIssueLabels(...args),
  removeIssueLabel: (...args: unknown[]) => removeIssueLabel(...args),
  fetchRepositoryLabelNames: (...args: unknown[]) => fetchRepositoryLabelNames(...args),
  fetchIssueLabelNames: (...args: unknown[]) => fetchIssueLabelNames(...args),
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
  fetchIssueLabelNames.mockReset();
  removeIssueLabel.mockResolvedValue([]);
  // 既定は「セッション自身が付けた確認待ち」（外してよい）
  fetchIssueLabelNames.mockResolvedValue(["00.check-user", "01.check-input"]);
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

  it("keepExistingReasonsに挙げた理由が既に付いていれば、付け替えない（#1905）", async () => {
    // 計画を出した直後の承認プロンプトで飛ぶ`Notification`。`01.check-plan`を
    // `01.check-input`へ落とすと、画面が「計画の承認」を待っていることを表せなくなる
    addIssueLabels.mockResolvedValue(["00.check-user", "01.check-plan", "21.plan-required"]);
    fetchRepositoryLabelNames.mockResolvedValue(ALL_REASON_LABELS);

    await addCheckUserWithReason("guchi-apps", "issue-deck", 10, "token", "input", {
      keepExistingReasons: ["plan"],
    });

    // `00.check-user`の付与だけで終わる（理由の付け替えもラベル一覧の取得もしない）
    expect(addIssueLabels).toHaveBeenCalledTimes(1);
    expect(removeIssueLabel).not.toHaveBeenCalled();
    expect(fetchRepositoryLabelNames).not.toHaveBeenCalled();
  });

  it("keepExistingReasonsの理由が付いていなければ、いつもどおり付け替える（#1905）", async () => {
    addIssueLabels.mockResolvedValue(["00.check-user", "01.check-answered"]);
    fetchRepositoryLabelNames.mockResolvedValue(ALL_REASON_LABELS);

    await addCheckUserWithReason("guchi-apps", "issue-deck", 11, "token", "input", {
      keepExistingReasons: ["plan"],
    });

    expect(addIssueLabels).toHaveBeenNthCalledWith(2, "guchi-apps", "issue-deck", 11, "token", [
      "01.check-input",
    ]);
    expect(removeIssueLabel.mock.calls.map((call) => call[4])).toEqual(["01.check-answered"]);
  });

  it("ラベル一覧の取得に失敗しても、00.check-userの付与は巻き添えにしない", async () => {
    addIssueLabels.mockResolvedValue(["00.check-user"]);
    fetchRepositoryLabelNames.mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // ラベル一覧が引けなくても、付与直後のラベル名は返す（#1855。呼び出し元はこれを見て
    // 計画レビューを起こすかどうかを決める）
    await expect(
      addCheckUserWithReason("guchi-apps", "issue-deck", 4, "token", "plan"),
    ).resolves.toEqual(["00.check-user"]);

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
    fetchIssueLabelNames.mockResolvedValue(["11.local"]);
    removeIssueLabel.mockResolvedValueOnce(null);

    await removeCheckUserWithReason("guchi-apps", "issue-deck", 6, "token");

    expect(removeIssueLabel).toHaveBeenCalledTimes(1);
  });

  it("別の実行体が付けた理由（01.check-merge）なら外さない（#1905）", async () => {
    // 印はセッションをまたいで引き継がれるため、置いた後にレビュー・統合が
    // 「PRをマージしてください」へ付け替えていることがある
    fetchIssueLabelNames.mockResolvedValue(["00.check-user", "01.check-merge"]);

    await removeCheckUserWithReason("guchi-apps", "issue-deck", 7, "token");

    expect(removeIssueLabel).not.toHaveBeenCalled();
  });

  it("無人実行が付けた01.check-answeredも外さない（#1905）", async () => {
    fetchIssueLabelNames.mockResolvedValue(["00.check-user", "00.qa-answered"]);

    await removeCheckUserWithReason("guchi-apps", "issue-deck", 8, "token");

    expect(removeIssueLabel).not.toHaveBeenCalled();
  });

  it("理由ラベルが配られていないリポジトリでは、従来どおり外す（#1905）", async () => {
    fetchIssueLabelNames.mockResolvedValue(["00.check-user", "11.local"]);
    removeIssueLabel.mockResolvedValueOnce(["11.local"]);

    await removeCheckUserWithReason("guchi-apps", "shopping-list", 9, "token");

    expect(removeIssueLabel.mock.calls.map((call) => call[4])).toEqual(["00.check-user"]);
  });

  it("ラベルを読めなくても外す側に倒す（確認待ちが解けないままになるのを避ける。#1905）", async () => {
    fetchIssueLabelNames.mockRejectedValue(new Error("boom"));
    removeIssueLabel.mockResolvedValueOnce(["01.check-input"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await removeCheckUserWithReason("guchi-apps", "issue-deck", 12, "token");

    expect(removeIssueLabel.mock.calls.map((call) => call[4])).toEqual([
      "00.check-user",
      "01.check-input",
    ]);
    error.mockRestore();
  });
});
