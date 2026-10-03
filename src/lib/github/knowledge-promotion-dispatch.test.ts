import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const dispatchWorkflow = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findFirst() {
        return findFirst;
      },
    },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));
vi.mock("@/lib/github/workflow-dispatch", () => ({
  get dispatchWorkflow() {
    return dispatchWorkflow;
  },
}));

import {
  dispatchKnowledgePromotion,
  isPromotionTriggerStatus,
  promotionDispatchIntervalMinutes,
  resetPromotionDispatchForTest,
} from "@/lib/github/knowledge-promotion-dispatch";

describe("isPromotionTriggerStatus", () => {
  it("develop・done・closedだけが契機になる", () => {
    expect(isPromotionTriggerStatus("develop")).toBe(true);
    expect(isPromotionTriggerStatus("done")).toBe(true);
    expect(isPromotionTriggerStatus("closed")).toBe(true);
    expect(isPromotionTriggerStatus("implementation")).toBe(false);
  });
});

describe("promotionDispatchIntervalMinutes", () => {
  it("未設定・不正は既定の10分、0は無効", () => {
    expect(promotionDispatchIntervalMinutes(undefined)).toBe(10);
    expect(promotionDispatchIntervalMinutes("abc")).toBe(10);
    expect(promotionDispatchIntervalMinutes("-1")).toBe(10);
    expect(promotionDispatchIntervalMinutes("0")).toBe(0);
    expect(promotionDispatchIntervalMinutes("3")).toBe(3);
  });
});

describe("dispatchKnowledgePromotion", () => {
  beforeEach(() => {
    resetPromotionDispatchForTest();
    findFirst.mockReset().mockResolvedValue({
      defaultBranch: "main",
      installation: { installationId: 1 },
    });
    getInstallationToken.mockReset().mockResolvedValue("tok");
    dispatchWorkflow.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("docsの判定ワークフローを既定ブランチで起動する", async () => {
    expect(await dispatchKnowledgePromotion(new Date("2026-10-03T00:00:00Z"))).toBe("dispatched");
    expect(dispatchWorkflow).toHaveBeenCalledWith("guchi-apps", "docs", "promote-knowledge.yml", "main", {}, "tok");
  });

  it("間隔内の2回目は間引き、過ぎれば再び起動する", async () => {
    await dispatchKnowledgePromotion(new Date("2026-10-03T00:00:00Z"));
    expect(await dispatchKnowledgePromotion(new Date("2026-10-03T00:05:00Z"))).toBe("throttled");
    expect(await dispatchKnowledgePromotion(new Date("2026-10-03T00:11:00Z"))).toBe("dispatched");
    expect(dispatchWorkflow).toHaveBeenCalledTimes(2);
  });

  it("起動に失敗しても例外を投げず、failedを返す", async () => {
    dispatchWorkflow.mockRejectedValue(new Error("403"));
    expect(await dispatchKnowledgePromotion()).toBe("failed");
  });

  it("docsのRepository行が無ければfailed", async () => {
    findFirst.mockResolvedValue(null);
    expect(await dispatchKnowledgePromotion()).toBe("failed");
    expect(dispatchWorkflow).not.toHaveBeenCalled();
  });
});
