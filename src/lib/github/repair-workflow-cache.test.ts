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
    // 前提の`claude-issue-dispatch.yml`はあるので、無い側は「これから配れる」扱いになる。
    fetchWorkflowExists.mockImplementation(
      async (_owner, _repo, file: string) => file !== "claude-conflict-resolve.yml",
    );

    const availability = await fetchRepairWorkflowAvailability(
      "guchi-apps",
      "issue-deck",
      ISSUE_PR,
      ["conflict", "ci"],
      "token",
    );

    expect(availability).toEqual({ ci: "available", conflict: "missing" });
  });

  it("前提のワークフローが無いリポジトリは配布の対象外として返す（#1948の配布条件）", async () => {
    // `release-develop-to-main.yml`はあるが`claude-issue-dispatch.yml`が無いリポジトリでは、
    // `issue-<番号>`のPRに出るボタンの起動先を配布の一覧から配れない。
    fetchWorkflowExists.mockResolvedValue(false);

    const availability = await fetchRepairWorkflowAvailability(
      "guchi-apps",
      "vps",
      ISSUE_PR,
      ["ci"],
      "token",
    );

    expect(availability).toEqual({ ci: "unsupported" });
    expect(fetchWorkflowExists).toHaveBeenCalledWith(
      "guchi-apps",
      "vps",
      "claude-issue-dispatch.yml",
      "token",
    );
  });

  it("無人実行のcallerが無いリポジトリのバンプPRは、配布の対象外として返す", async () => {
    // #2303。`vps`と同じ構成（`release-develop-to-main.yml`はあるが
    // `claude-issue-dispatch.yml`が無い）。`requires`が複数になったので、
    // 「リリースフローがあるから配れます」と案内してはいけない——配布スクリプトは
    // 参照タグと`with:`の写し元が無く必ず失敗する
    fetchWorkflowExists.mockImplementation(
      async (_owner, _repo, file: string) => file === "release-develop-to-main.yml",
    );

    const availability = await fetchRepairWorkflowAvailability(
      "guchi-apps",
      "vps",
      BUMP_PR,
      ["ci"],
      "token",
    );

    expect(availability).toEqual({ ci: "unsupported" });
    // 欠けが見つかった時点で打ち切るので、`release-develop-to-main.yml`は問い合わせない
    expect(fetchWorkflowExists).toHaveBeenCalledWith(
      "guchi-apps",
      "vps",
      "claude-issue-dispatch.yml",
      "token",
    );
    expect(fetchWorkflowExists).not.toHaveBeenCalledWith(
      "guchi-apps",
      "vps",
      "release-develop-to-main.yml",
      "token",
    );
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

    expect(availability).toEqual({ ci: "available", conflict: "available" });
    expect(fetchWorkflowExists).toHaveBeenCalledTimes(1);
    expect(fetchWorkflowExists).toHaveBeenCalledWith(
      "guchi-apps",
      "issue-deck",
      "claude-pr-repair.yml",
      "token",
    );
  });

  it("2回目以降はキャッシュを使い、GitHub APIを消費しない", async () => {
    fetchWorkflowExists.mockResolvedValue(true);

    await fetchRepairWorkflowAvailability("guchi-apps", "issue-deck", BUMP_PR, ["ci"], "token");
    const second = await fetchRepairWorkflowAvailability(
      "guchi-apps",
      "issue-deck",
      BUMP_PR,
      ["ci"],
      "token",
    );

    expect(second).toEqual({ ci: "available" });
    expect(fetchWorkflowExists).toHaveBeenCalledTimes(1);
  });

  it("未配布は短いTTLで確認し直し、配布済みは持ち続ける", async () => {
    // 配布PRがマージされた直後に「配ったのに押せない」時間ができないよう、無い側だけ短く持つ。
    vi.useFakeTimers();
    try {
      fetchWorkflowExists.mockImplementation(
        async (_owner, _repo, file: string) => file === "claude-issue-dispatch.yml",
      );

      await fetchRepairWorkflowAvailability("guchi-apps", "issue-deck", ISSUE_PR, ["ci"], "token");
      expect(fetchWorkflowExists).toHaveBeenCalledTimes(2);

      // 1分経つと未配布（`claude-ci-fix.yml`）だけ問い合わせ直す。
      vi.advanceTimersByTime(61_000);
      await fetchRepairWorkflowAvailability("guchi-apps", "issue-deck", ISSUE_PR, ["ci"], "token");
      expect(fetchWorkflowExists).toHaveBeenCalledTimes(3);

      // 10分経てば配布済みの側（前提ワークフロー）も確認し直す。
      vi.advanceTimersByTime(10 * 60_000);
      await fetchRepairWorkflowAvailability("guchi-apps", "issue-deck", ISSUE_PR, ["ci"], "token");
      expect(fetchWorkflowExists).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
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

    expect(second).toEqual({ ci: "available" });
    expect(fetchWorkflowExists).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
