import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionPlanRequestFindUnique = vi.fn();
const sessionPlanRequestUpdate = vi.fn();
const sessionPlanRequestUpdateMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    sessionPlanRequest: {
      get findUnique() {
        return sessionPlanRequestFindUnique;
      },
      get update() {
        return sessionPlanRequestUpdate;
      },
      get updateMany() {
        return sessionPlanRequestUpdateMany;
      },
    },
  },
}));

import { releaseSessionPlanRequest, reportSessionPlanDelivery } from "@/lib/dispatch/plan-requests";

const NOW = new Date("2026-08-22T10:30:00.000Z");

/** `SessionPlanRequest`の行のうち、ここで見るものだけを持つ最小の形 */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 2108,
    status: "WAITING",
    revisionText: null,
    expiresAt: new Date(NOW.getTime() + 30 * 60 * 1000),
    deliveredAt: null,
    ...overrides,
  };
}

/**
 * フックが「待つのをやめた」と申告する経路（#2108）。
 *
 * ここが効かないと、画面は待ち時間いっぱい「計画の承認を待っています」を出し続け、
 * **押しても誰も受け取らないボタン**が残る。
 */
describe("releaseSessionPlanRequest", () => {
  beforeEach(() => {
    sessionPlanRequestFindUnique.mockReset();
    sessionPlanRequestUpdate.mockReset().mockResolvedValue(row());
    sessionPlanRequestUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it("待っている行を`DEFERRED`へ畳む", async () => {
    sessionPlanRequestFindUnique.mockResolvedValue(row({ status: "DEFERRED", deliveredAt: NOW }));

    const outcome = await releaseSessionPlanRequest("req-1", NOW);

    expect(outcome).toEqual({ status: "DEFERRED", revisionText: null });
    expect(sessionPlanRequestUpdateMany).toHaveBeenCalledWith({
      // **`WAITING`のときだけ畳む**（決まっている行を上書きしない）
      where: { id: "req-1", status: "WAITING" },
      data: { status: "DEFERRED", decidedAt: NOW, deliveredAt: NOW },
    });
  });

  it("降りる直前に押されていたら、その結論を返す（最後の確認を兼ねる）", async () => {
    sessionPlanRequestUpdateMany.mockResolvedValue({ count: 0 });
    sessionPlanRequestFindUnique.mockResolvedValue(
      row({ status: "REVISION_REQUESTED", revisionText: "懸念点を具体的に" }),
    );

    const outcome = await releaseSessionPlanRequest("req-1", NOW);

    expect(outcome).toEqual({ status: "REVISION_REQUESTED", revisionText: "懸念点を具体的に" });
  });

  it("行が無ければ`null`（フックは何も返さずに終える）", async () => {
    sessionPlanRequestFindUnique.mockResolvedValue(null);

    expect(await releaseSessionPlanRequest("req-1", NOW)).toBeNull();
  });
});

describe("reportSessionPlanDelivery", () => {
  beforeEach(() => {
    sessionPlanRequestUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it("判断取得後のセッション処理結果を一度だけ記録する", async () => {
    const reported = await reportSessionPlanDelivery({
      id: "req-1",
      status: "PROCESS_FAILED",
      exitCode: 3,
      summary: "計画の画面待機が終了しました",
      now: NOW,
    });

    expect(reported).toBe(true);
    expect(sessionPlanRequestUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "req-1",
        status: { not: "WAITING" },
        decisionObservedAt: { not: null },
        deliveryReportedAt: null,
      },
      data: {
        deliveryStatus: "PROCESS_FAILED",
        deliveryReportedAt: NOW,
        deliveryExitCode: 3,
        deliverySummary: "計画の画面待機が終了しました",
      },
    });
  });
});
