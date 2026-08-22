import { describe, expect, it } from "vitest";

import {
  isRepairKind,
  isRepairRunActive,
  isRepairRunStatus,
  repairRunKey,
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

  it("終了が報告された行は走っていない", () => {
    expect(isRepairRunActive({ status: "finished", startedAt: minutesAgo(1) }, NOW)).toBe(false);
  });

  // 実行そのものがキャンセルされると終了の報告が届かず、`running`のまま残る。
  // 画面に「自動修正中」が出続ける方が害が大きいため、時間で失効させる（#2072）。
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
