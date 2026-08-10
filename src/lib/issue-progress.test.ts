import { describe, expect, it } from "vitest";

import {
  LABELED_PROGRESS_STATUSES,
  PROGRESS_STATUSES,
  getProgressStatusIndex,
  hasActiveProgress,
  matchProgressLabels,
  matchProjectStatus,
  resolveProgressStatus,
} from "@/lib/issue-progress";
import type { IssueLabel } from "@/types/issue";

function labels(...names: string[]): IssueLabel[] {
  return names.map((name) => ({ name, color: "#000000", description: null }));
}

describe("PROGRESS_STATUSES の定義", () => {
  it("readyだけがラベルを持たず、残りはすべてラベルを持つ", () => {
    expect(PROGRESS_STATUSES.filter((status) => status.labelName === null)).toHaveLength(1);
    expect(PROGRESS_STATUSES[0].key).toBe("ready");
    expect(LABELED_PROGRESS_STATUSES).toHaveLength(PROGRESS_STATUSES.length - 1);
  });

  it("Status名とラベル名に重複がない", () => {
    const statusNames = PROGRESS_STATUSES.map((status) => status.projectStatus);
    const labelNames = LABELED_PROGRESS_STATUSES.map((status) => status.labelName);
    expect(new Set(statusNames).size).toBe(statusNames.length);
    expect(new Set(labelNames).size).toBe(labelNames.length);
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

describe("matchProgressLabels", () => {
  it("進捗ラベルから状態を引ける", () => {
    expect(matchProgressLabels(labels("02.wip"))).toBe("implementation");
    expect(matchProgressLabels(labels("09.main"))).toBe("done");
  });

  it("進捗ラベルが無ければreadyになる", () => {
    expect(matchProgressLabels([])).toBe("ready");
    expect(matchProgressLabels(labels("00.check-user", "70.confirm"))).toBe("ready");
  });

  it("新旧のラベルが同時に付いている過渡期は手前の状態を優先する", () => {
    expect(matchProgressLabels(labels("05.develop", "02.wip"))).toBe("implementation");
    expect(matchProgressLabels(labels("09.main", "01.planning"))).toBe("planning");
  });
});

describe("resolveProgressStatus", () => {
  it("Project Statusがあればそれを優先する", () => {
    expect(resolveProgressStatus({ projectStatus: "Release", labels: [] })).toBe("release");
  });

  it("Statusとラベルが食い違う場合はStatusが勝つ", () => {
    expect(
      resolveProgressStatus({ projectStatus: "Done", labels: labels("02.wip") }),
    ).toBe("done");
  });

  it("Statusが無ければラベルへフォールバックする", () => {
    expect(resolveProgressStatus({ projectStatus: null, labels: labels("03.d:marge") })).toBe(
      "develop-pr",
    );
  });

  it("Statusもラベルも無ければreadyになる", () => {
    expect(resolveProgressStatus({ projectStatus: null, labels: [] })).toBe("ready");
  });

  it("未知のStatus名はラベルへフォールバックする（画面が空になるのを避ける）", () => {
    expect(
      resolveProgressStatus({ projectStatus: "Blocked", labels: labels("02.wip") }),
    ).toBe("implementation");
  });

  it("Projectから外れてStatusがnullに戻ればラベル起点の判定へ戻る", () => {
    const issue = { projectStatus: "Done" as string | null, labels: labels("02.wip") };
    expect(resolveProgressStatus(issue)).toBe("done");
    issue.projectStatus = null;
    expect(resolveProgressStatus(issue)).toBe("implementation");
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
    expect(hasActiveProgress({ projectStatus: "Implementation", labels: [] })).toBe(true);
  });

  it("マージ後の定常状態はfalse", () => {
    expect(hasActiveProgress({ projectStatus: "Develop", labels: [] })).toBe(false);
    expect(hasActiveProgress({ projectStatus: "Done", labels: [] })).toBe(false);
  });

  it("未着手はfalse", () => {
    expect(hasActiveProgress({ projectStatus: "Ready", labels: [] })).toBe(false);
    expect(hasActiveProgress({ projectStatus: null, labels: [] })).toBe(false);
  });

  it("Statusが無ければラベルで判定する", () => {
    expect(hasActiveProgress({ projectStatus: null, labels: labels("02.wip") })).toBe(true);
    expect(hasActiveProgress({ projectStatus: null, labels: labels("05.develop") })).toBe(false);
  });

  it("ラベル判定は過渡期の同時付与を拾う（activeなラベルが1つでもあればtrue）", () => {
    expect(
      hasActiveProgress({ projectStatus: null, labels: labels("05.develop", "07.m:marge") }),
    ).toBe(true);
  });

  it("未知のStatus名はラベルへフォールバックする", () => {
    expect(hasActiveProgress({ projectStatus: "Blocked", labels: labels("02.wip") })).toBe(true);
  });
});
