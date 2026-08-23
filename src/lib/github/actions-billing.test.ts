import { describe, expect, it } from "vitest";

import {
  startOfJstDay,
  summarizeActionsUsage,
  type BillingUsageItem,
} from "@/lib/github/actions-billing";

function item(overrides: Partial<BillingUsageItem>): BillingUsageItem {
  return {
    date: "2026-08-10T15:48:02Z",
    product: "actions",
    sku: "Actions Linux",
    quantity: 10,
    unitType: "Minutes",
    netAmount: 0,
    repositoryName: "issue-deck",
    ...overrides,
  };
}

const options = { year: 2026, month: 8, todayStartedAt: Date.parse("2026-08-23T00:00:00Z") };

describe("summarizeActionsUsage", () => {
  it("Actionsの分数だけを合計し、ストレージと他のプロダクトは混ぜない", () => {
    const usage = summarizeActionsUsage(
      [
        item({ quantity: 285 }),
        item({ quantity: 64, repositoryName: "shopping-list" }),
        item({ sku: "Actions storage", unitType: "GigabyteHours", quantity: 1486.75 }),
        item({ product: "ghas", sku: "Secret Protection", unitType: "UserMonths", quantity: 1, netAmount: 19 }),
      ],
      options,
    );

    expect(usage.thisMonth.minutes).toBe(349);
    expect(usage.storageGigabyteHours).toBeCloseTo(1486.75);
    expect(usage.thisMonth.netAmount).toBe(0);
  });

  it("リポジトリ別に集計し、実行時間の多い順に並べる", () => {
    const usage = summarizeActionsUsage(
      [
        item({ quantity: 100, repositoryName: "a" }),
        item({ quantity: 300, repositoryName: "b" }),
        item({ quantity: 50, repositoryName: "b" }),
      ],
      options,
    );

    expect(usage.thisMonth.repositories.map((repository) => [repository.name, repository.minutes])).toEqual([
      ["b", 350],
      ["a", 100],
    ]);
  });

  it("上位5件を超えたリポジトリは「ほかN件」へまとめる", () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      item({ quantity: 100 - index, repositoryName: `repo-${index}` }),
    );

    const usage = summarizeActionsUsage(items, options);

    expect(usage.thisMonth.repositories).toHaveLength(5);
    expect(usage.thisMonth.otherRepositoryCount).toBe(3);
    expect(usage.thisMonth.otherMinutes).toBe(95 + 94 + 93);
  });

  it("課金が発生しているリポジトリは、実行時間が短くてもまとめずに残す", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, index) =>
        item({ quantity: 100 - index, repositoryName: `free-${index}` }),
      ),
      item({ quantity: 1, repositoryName: "vps", netAmount: 0.018 }),
    ];

    const usage = summarizeActionsUsage(items, options);

    expect(usage.thisMonth.repositories.map((repository) => repository.name)).toContain("vps");
    // 上位5件＋課金ありの1件。埋もれた1件だけが「ほか」へ回る
    expect(usage.thisMonth.repositories).toHaveLength(6);
    expect(usage.thisMonth.otherRepositoryCount).toBe(1);
  });

  it("「今日」は起点以降の明細だけを数える", () => {
    const usage = summarizeActionsUsage(
      [
        item({ date: "2026-08-22T23:59:59Z", quantity: 500 }),
        item({ date: "2026-08-23T00:00:00Z", quantity: 30 }),
        item({ date: "2026-08-23T09:00:00Z", quantity: 12 }),
      ],
      options,
    );

    expect(usage.today.minutes).toBe(42);
    expect(usage.thisMonth.minutes).toBe(542);
  });

  it("明細が無くても0で返す", () => {
    const usage = summarizeActionsUsage([], options);

    expect(usage.thisMonth.minutes).toBe(0);
    expect(usage.thisMonth.repositories).toEqual([]);
    expect(usage.today.otherRepositoryCount).toBe(0);
  });
});

describe("startOfJstDay", () => {
  it("実行環境がUTCでも、日本時間のその日の0時を返す", () => {
    // JSTでは2026-08-24 07:34。UTCの日付（8/23）に引きずられない
    const now = new Date("2026-08-23T22:34:56Z");

    expect(startOfJstDay(now)).toBe(Date.parse("2026-08-23T15:00:00Z"));
  });
});
