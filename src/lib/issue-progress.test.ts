import { describe, expect, it } from "vitest";

import {
  ADVANCED_PROGRESS_STATUSES,
  PROGRESS_STATUSES,
  getProgressStatusIndex,
  hasActiveProgress,
  matchProjectStatus,
  parseProgressStatusKey,
  resolveProgressStatus,
} from "@/lib/issue-progress";

describe("PROGRESS_STATUSES の定義", () => {
  it("先頭がreadyで、それ以外がステップ表示の対象になる", () => {
    expect(PROGRESS_STATUSES[0].key).toBe("ready");
    expect(ADVANCED_PROGRESS_STATUSES).toHaveLength(PROGRESS_STATUSES.length - 1);
    expect(ADVANCED_PROGRESS_STATUSES.some((status) => status.key === "ready")).toBe(false);
  });

  it("Status名に重複がない", () => {
    const statusNames = PROGRESS_STATUSES.map((status) => status.projectStatus);
    expect(new Set(statusNames).size).toBe(statusNames.length);
  });

  it("マージ後の定常状態と未着手はactiveではない", () => {
    const inactive = PROGRESS_STATUSES.filter((status) => !status.active).map((s) => s.key);
    expect(inactive).toEqual(["ready", "develop", "done"]);
  });
});

describe("matchProjectStatus", () => {
  it("Status名から状態を引ける", () => {
    expect(matchProjectStatus("Implementation")).toBe("implementation");
    expect(matchProjectStatus("Develop PR")).toBe("develop-pr");
    expect(matchProjectStatus("Done")).toBe("done");
  });

  it("未知のStatus名はnullを返す", () => {
    expect(matchProjectStatus("Blocked")).toBeNull();
    expect(matchProjectStatus("")).toBeNull();
  });
});

describe("resolveProgressStatus", () => {
  it("Project Statusから状態を引く", () => {
    expect(resolveProgressStatus({ projectStatus: "Release" })).toBe("release");
    expect(resolveProgressStatus({ projectStatus: "Develop PR" })).toBe("develop-pr");
  });

  it("Statusが無ければready（未着手）になる", () => {
    // Phase 5で進捗ラベルを廃止したため、フォールバック先が無い。Projectへ載っていない
    // リポジトリのIssueは一律「未着手」に見える
    expect(resolveProgressStatus({ projectStatus: null })).toBe("ready");
  });

  it("未知のStatus名もreadyとして扱う", () => {
    expect(resolveProgressStatus({ projectStatus: "Blocked" })).toBe("ready");
  });
});

describe("getProgressStatusIndex", () => {
  it("遷移順のとおりに並ぶ", () => {
    expect(getProgressStatusIndex("ready")).toBe(0);
    expect(getProgressStatusIndex("done")).toBe(PROGRESS_STATUSES.length - 1);
    expect(getProgressStatusIndex("develop")).toBeGreaterThan(
      getProgressStatusIndex("develop-pr"),
    );
  });
});

describe("hasActiveProgress", () => {
  it("Statusがactiveな状態ならtrue", () => {
    expect(hasActiveProgress({ projectStatus: "Implementation" })).toBe(true);
    expect(hasActiveProgress({ projectStatus: "Planning" })).toBe(true);
  });

  it("マージ後の定常状態はfalse", () => {
    expect(hasActiveProgress({ projectStatus: "Develop" })).toBe(false);
    expect(hasActiveProgress({ projectStatus: "Done" })).toBe(false);
  });

  it("未着手・Status無し・未知のStatus名はfalse", () => {
    expect(hasActiveProgress({ projectStatus: "Ready" })).toBe(false);
    expect(hasActiveProgress({ projectStatus: null })).toBe(false);
    expect(hasActiveProgress({ projectStatus: "Blocked" })).toBe(false);
  });
});

describe("parseProgressStatusKey", () => {
  it("定義済みの状態キーだけを受け付ける", () => {
    expect(parseProgressStatusKey("implementation")).toBe("implementation");
    expect(parseProgressStatusKey("develop-pr")).toBe("develop-pr");
    expect(parseProgressStatusKey("done")).toBe("done");
  });

  it("ラベル名・Status名・未知の値・非文字列はnullを返す", () => {
    // 報告API・問い合わせAPIが受けるのは状態キーであり、ラベル名やProject Status名ではない
    expect(parseProgressStatusKey("02.wip")).toBeNull();
    expect(parseProgressStatusKey("Implementation")).toBeNull();
    expect(parseProgressStatusKey("blocked")).toBeNull();
    expect(parseProgressStatusKey(undefined)).toBeNull();
    expect(parseProgressStatusKey(3)).toBeNull();
  });

  it("PROGRESS_STATUSESの全キーを受け付ける", () => {
    for (const status of PROGRESS_STATUSES) {
      expect(parseProgressStatusKey(status.key)).toBe(status.key);
    }
  });
});
