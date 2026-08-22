import { describe, expect, it } from "vitest";

import {
  isRepairKind,
  isRepairRunActive,
  isRepairRunStatus,
  isRepairSymptomGone,
  repairRunKey,
  visibleRepairRun,
  REPAIR_RUN_STALE_MINUTES,
} from "@/lib/github/pull-request-repair-run";

const NOW = new Date("2026-08-22T10:00:00.000Z");

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

describe("isRepairRunActive", () => {
  it("始まったばかりの実行は走っているものとして扱う", () => {
    expect(isRepairRunActive({ status: "running", startedAt: minutesAgo(3) }, NOW)).toBe(true);
  });

  // 実行が長引いた程度でピルが消えると、このIssueの困りごとにそのまま戻る。
  it("実測より長く（1時間）かかっている実行でもまだ走っているものとして扱う", () => {
    expect(isRepairRunActive({ status: "running", startedAt: minutesAgo(60) }, NOW)).toBe(true);
  });

  it("終了が報告された行は走っていない", () => {
    expect(isRepairRunActive({ status: "finished", startedAt: minutesAgo(1) }, NOW)).toBe(false);
  });

  // runnerごと落ちると終了の報告が届かず、`running`のまま残る。ジョブの既定タイムアウト
  // （360分）を超えて生き続けることはないので、そこを上限に失効させる（#2072）。
  it("終了の報告が届かないまま時間が経った行は走っていないものとして扱う", () => {
    expect(
      isRepairRunActive({ status: "running", startedAt: minutesAgo(REPAIR_RUN_STALE_MINUTES + 1) }, NOW),
    ).toBe(false);
  });

  it("失効の境目の手前ではまだ走っているものとして扱う", () => {
    expect(
      isRepairRunActive({ status: "running", startedAt: minutesAgo(REPAIR_RUN_STALE_MINUTES - 1) }, NOW),
    ).toBe(true);
  });
});

describe("isRepairKind / isRepairRunStatus", () => {
  it("受け付ける値だけを通す", () => {
    expect(isRepairKind("ci")).toBe(true);
    expect(isRepairKind("conflict")).toBe(true);
    expect(isRepairKind("deploy")).toBe(false);
    expect(isRepairKind(undefined)).toBe(false);

    expect(isRepairRunStatus("running")).toBe(true);
    expect(isRepairRunStatus("finished")).toBe(true);
    expect(isRepairRunStatus("failed")).toBe(false);
  });
});

describe("repairRunKey", () => {
  it("リポジトリとPR番号で引けるキーを作る", () => {
    expect(repairRunKey("guchi-apps/issue-deck", 2068)).toBe("guchi-apps/issue-deck#2068");
  });
});

describe("isRepairSymptomGone", () => {
  it("コンフリクトが解消されていれば、コンフリクト解消は終わっているとみなす", () => {
    expect(isRepairSymptomGone("conflict", { mergeable: true })).toBe(true);
    expect(isRepairSymptomGone("conflict", { mergeable: false })).toBe(false);
  });

  // GitHubが判定中の`null`を「解消済み」に倒すと、走っている最中にピルが消える。
  it("コンフリクト有無が未判定なら、まだ消えていないものとして扱う", () => {
    expect(isRepairSymptomGone("conflict", { mergeable: null })).toBe(false);
    expect(isRepairSymptomGone("conflict", {})).toBe(false);
  });

  it("CIが通っていれば、CI失敗の自動修正は終わっているとみなす", () => {
    expect(isRepairSymptomGone("ci", { ciState: "success" })).toBe(true);
    expect(isRepairSymptomGone("ci", { ciState: "failure" })).toBe(false);
    expect(isRepairSymptomGone("ci", { ciState: "pending" })).toBe(false);
    expect(isRepairSymptomGone("ci", { ciState: null })).toBe(false);
  });

  it("種別ごとに見る軸が違う（コンフリクトはCI状態を見ない）", () => {
    expect(isRepairSymptomGone("conflict", { mergeable: false, ciState: "success" })).toBe(false);
    expect(isRepairSymptomGone("ci", { mergeable: true, ciState: "failure" })).toBe(false);
  });
});

describe("visibleRepairRun", () => {
  const conflictRun = {
    kind: "conflict",
    startedAt: NOW.toISOString(),
    runUrl: null,
  } as const;

  // 終了の報告が届かないと`running`の行が6時間残る。行の有無だけで出すと、解消後も
  // 「コンフリクトを自動解消中」が消えない（#2165）。
  it("コンフリクトが解消されたPRでは出さない", () => {
    expect(visibleRepairRun(conflictRun, { mergeable: true })).toBeNull();
  });

  it("コンフリクトしたままのPRでは出す", () => {
    expect(visibleRepairRun(conflictRun, { mergeable: false })).toEqual(conflictRun);
    expect(visibleRepairRun(conflictRun, { mergeable: null })).toEqual(conflictRun);
  });

  it("走っている修復が無ければnullのまま", () => {
    expect(visibleRepairRun(null, { mergeable: false })).toBeNull();
  });

  it("CI失敗の自動修正は、CIが通った時点で出さない", () => {
    const ciRun = { kind: "ci", startedAt: NOW.toISOString(), runUrl: null } as const;
    expect(visibleRepairRun(ciRun, { ciState: "success" })).toBeNull();
    expect(visibleRepairRun(ciRun, { ciState: "failure" })).toEqual(ciRun);
  });
});
