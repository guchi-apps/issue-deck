import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWorkflowExists = vi.fn();

vi.mock("@/lib/github/release-api", () => ({ fetchWorkflowExists }));

const {
  clearRepairWorkflowExistsCacheForTest,
  fetchRepairWorkflowAvailability,
} = await import("@/lib/github/repair-workflow-cache");

/** develop向けの`issue-<番号>`PR。CI失敗とコンフリクトで起動先のワークフローが分かれる */
const ISSUE_PR = { number: 12, baseRef: "develop", headRef: "issue-34" };
/** バンプPR。Issueを持たないため、どちらの種類も`claude-pr-repair.yml`が受け持つ */
const BUMP_PR = { number: 99, baseRef: "develop", headRef: "release/v1.2.3" };

describe("fetchRepairWorkflowAvailability", () => {
  beforeEach(() => {
    clearRepairWorkflowExistsCacheForTest();
    fetchWorkflowExists.mockReset();
  });

  it("種類ごとの起動先ワークフローの有無を返す", async () => {
    fetchWorkflowExists.mockImplementation(async (_owner, _repo, file: string) =>
      file === "claude-ci-fix.yml",
    );

    const availability = await fetchRepairWorkflowAvailability(
      "guchi-apps",
      "issue-deck",
      ISSUE_PR,
      ["conflict", "ci"],
      "token",
    );

    expect(availability).toEqual({ ci: true, conflict: false });
  });

  it("ボタンを出す種類が無ければGitHub APIを呼ばない", async () => {
    const availability = await fetchRepairWorkflowAvailability(
      "guchi-apps",
      "issue-deck",
      ISSUE_PR,
      [],
      "token",
    );

    expect(availability).toEqual({});
    expect(fetchWorkflowExists).not.toHaveBeenCalled();
  });

  it("同じワークフローを見る種類が並んでも問い合わせは1回にまとめる", async () => {
    fetchWorkflowExists.mockResolvedValue(true);

    const availability = await fetchRepairWorkflowAvailability(
      "guchi-apps",
      "issue-deck",
      BUMP_PR,
      ["conflict", "ci"],
      "token",
    );

    expect(availability).toEqual({ ci: true, conflict: true });
    expect(fetchWorkflowExists).toHaveBeenCalledTimes(1);
    expect(fetchWorkflowExists).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      "claude-pr-repair.yml",
      "token",
    );
  });

  it("2回目以降はキャッシュを使い、GitHub APIを消費しない", async () => {
    fetchWorkflowExists.mockResolvedValue(false);

    await fetchRepairWorkflowAvailability("guchi-apps", "issue-deck", BUMP_PR, ["ci"], "token");
    const second = await fetchRepairWorkflowAvailability(
      "guchi-apps",
      "issue-deck",
      BUMP_PR,
      ["ci"],
      "token",
    );

    expect(second).toEqual({ ci: false });
    expect(fetchWorkflowExists).toHaveBeenCalledTimes(1);
  });

  it("判定に失敗した種類はキーを落とし、押せるままにする", async () => {
    // 権限・障害で落ちたときにボタンを無効化すると「配ってあるのに押せない」状態になる。
    fetchWorkflowExists.mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const availability = await fetchRepairWorkflowAvailability(
      "guchi-apps",
      "issue-deck",
      ISSUE_PR,
      ["ci"],
      "token",
    );

    expect(availability).toEqual({});
    warn.mockRestore();
  });

  it("失敗した判定はキャッシュせず、次の取得でやり直す", async () => {
    fetchWorkflowExists.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await fetchRepairWorkflowAvailability("guchi-apps", "issue-deck", ISSUE_PR, ["ci"], "token");
    const second = await fetchRepairWorkflowAvailability(
      "guchi-apps",
      "issue-deck",
      ISSUE_PR,
      ["ci"],
      "token",
    );

    expect(second).toEqual({ ci: true });
    expect(fetchWorkflowExists).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
