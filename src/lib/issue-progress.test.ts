import { describe, expect, it } from "vitest";

import {
  ADVANCED_PROGRESS_STATUSES,
  CLOSE_TERMINAL_SOURCE_STATUSES,
  PROGRESS_STATUSES,
  getProgressStatusIndex,
  hasActiveProgress,
  isNextReleaseIssue,
  isReleasePendingIssue,
  matchProjectStatus,
  parseProgressStatusKey,
  resolveProgressStatus,
} from "@/lib/issue-progress";

describe("PROGRESS_STATUSES の定義", () => {
  it("先頭がreadyで、readyと対応終了を除いた6状態がステップ表示の対象になる", () => {
    expect(PROGRESS_STATUSES[0].key).toBe("ready");
    // ステップ表示（WORKFLOW_STEPS）はPlanning〜Doneの一本道。ここが増えると通常のIssueの
    // 「実装中（2/6）」という分母まで変わるため、件数そのものを固定して押さえる（#1856）
    expect(ADVANCED_PROGRESS_STATUSES).toHaveLength(6);
    expect(ADVANCED_PROGRESS_STATUSES.map((status) => status.key)).toEqual([
      "planning",
      "implementation",
      "develop-pr",
      "develop",
      "release",
      "done",
    ]);
  });

  it("Status名に重複がない", () => {
    const statusNames = PROGRESS_STATUSES.map((status) => status.projectStatus);
    expect(new Set(statusNames).size).toBe(statusNames.length);
  });

  it("マージ後の定常状態・未着手・対応終了はactiveではない", () => {
    const inactive = PROGRESS_STATUSES.filter((status) => !status.active).map((s) => s.key);
    expect(inactive).toEqual(["ready", "develop", "done", "closed"]);
  });
});

describe("CLOSE_TERMINAL_SOURCE_STATUSES", () => {
  it("close時に終端へ送るのは実装中の3状態だけ（#1856）", () => {
    expect(CLOSE_TERMINAL_SOURCE_STATUSES).toEqual(["planning", "implementation", "develop-pr"]);
  });

  it("本番未反映の変更を抱える状態と未着手は含めない", () => {
    // `develop`・`release`はdevelopまで入って本番へ出ていない。`ready`は未着手のまま
    // 終わっただけで取り残しではない
    for (const key of ["ready", "develop", "release", "done", "closed"] as const) {
      expect(CLOSE_TERMINAL_SOURCE_STATUSES).not.toContain(key);
    }
  });
});

describe("matchProjectStatus", () => {
  it("Status名から状態を引ける", () => {
    expect(matchProjectStatus("Implementation")).toBe("implementation");
    expect(matchProjectStatus("Develop PR")).toBe("develop-pr");
    expect(matchProjectStatus("Done")).toBe("done");
    expect(matchProjectStatus("Closed")).toBe("closed");
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
    // 本流の終端は`done`。`closed`はそこから外れた終端なので、`done`の後ろに置く（#1856）
    expect(getProgressStatusIndex("closed")).toBe(PROGRESS_STATUSES.length - 1);
    expect(getProgressStatusIndex("closed")).toBeGreaterThan(getProgressStatusIndex("done"));
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

describe("isNextReleaseIssue", () => {
  it("`Develop`にいるopenなIssueだけを今回の反映対象とみなす", () => {
    expect(isNextReleaseIssue({ projectStatus: "Develop", state: "open" })).toBe(true);
    expect(isNextReleaseIssue({ projectStatus: "Release", state: "open" })).toBe(false);
    expect(isNextReleaseIssue({ projectStatus: "Implementation", state: "open" })).toBe(false);
  });

  it("closedなIssueは`Develop`に残っていても対象にしない（#1348）", () => {
    // リリース時にDoneへ一括遷移させる対象（GET /api/progress）はopenだけを返すため、
    // closedのまま`Develop`に残っているIssueは何度リリースしても反映されない
    expect(isNextReleaseIssue({ projectStatus: "Develop", state: "closed" })).toBe(false);
  });
});

describe("isReleasePendingIssue", () => {
  it("`Develop`・`Release`にいるopenなIssueを本番反映待ちとみなす", () => {
    expect(isReleasePendingIssue({ projectStatus: "Develop", state: "open" })).toBe(true);
    expect(isReleasePendingIssue({ projectStatus: "Release", state: "open" })).toBe(true);
    expect(isReleasePendingIssue({ projectStatus: "Done", state: "open" })).toBe(false);
  });

  it("closedなIssueは件数に数えない（#1348）", () => {
    expect(isReleasePendingIssue({ projectStatus: "Develop", state: "closed" })).toBe(false);
    expect(isReleasePendingIssue({ projectStatus: "Release", state: "closed" })).toBe(false);
  });
});
