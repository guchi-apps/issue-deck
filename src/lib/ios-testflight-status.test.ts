import { describe, expect, it } from "vitest";

import {
  buildNumberFromTag,
  judgeIosRun,
  latestDeliveredBuild,
  summarizeIosStages,
  toStageState,
} from "@/lib/ios-testflight-status";

const job = (name: string, conclusion: string | null, steps: { name: string; conclusion: string | null }[] = []) => ({
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  steps: steps.map((s) => ({ ...s, status: s.conclusion === null ? "in_progress" : "completed" })),
});

describe("toStageState", () => {
  it("完了・未完了・結論を状態へ寄せる", () => {
    expect(toStageState("completed", "success")).toBe("success");
    expect(toStageState("completed", "skipped")).toBe("skipped");
    expect(toStageState("completed", "cancelled")).toBe("failure");
    expect(toStageState("in_progress", null)).toBe("running");
    expect(toStageState("queued", null)).toBe("pending");
  });
});

describe("summarizeIosStages / judgeIosRun", () => {
  it("すべて成功なら配布済み", () => {
    const stages = summarizeIosStages([
      job("detect", "success"),
      job("testflight", "success", [
        { name: "Import signing certificate", conclusion: "success" },
        { name: "Archive build", conclusion: "success" },
        { name: "Upload to App Store Connect", conclusion: "success" },
        { name: "Wait for processing", conclusion: "success" },
        { name: "Add to internal group", conclusion: "success" },
      ]),
    ]);
    expect(stages.map((s) => s.state)).toEqual(["success", "success", "success", "success", "success", "success"]);
    expect(judgeIosRun({ status: "completed", conclusion: "success" }, stages)).toEqual({ kind: "delivered" });
  });

  it("Uploadはビルドではなくアップロード段階に数える", () => {
    const stages = summarizeIosStages([job("x", "failure", [{ name: "Upload build", conclusion: "failure" }])]);
    expect(stages.find((s) => s.key === "upload")?.state).toBe("failure");
    expect(stages.find((s) => s.key === "build")?.state).toBe("unknown");
  });

  it("更新不要の判定はスキップとして失敗と区別する", () => {
    const stages = summarizeIosStages([job("detect", "success"), job("testflight", "skipped")]);
    expect(judgeIosRun({ status: "completed", conclusion: "success" }, stages)).toEqual({ kind: "skipped" });
  });

  it("失敗した段階名を返す", () => {
    const stages = summarizeIosStages([
      job("detect", "success"),
      job("testflight", "failure", [
        { name: "Archive", conclusion: "success" },
        { name: "Upload", conclusion: "failure" },
      ]),
    ]);
    expect(judgeIosRun({ status: "completed", conclusion: "failure" }, stages)).toEqual({
      kind: "failed",
      failedStage: "アップロード",
    });
  });

  it("実行中は実行中", () => {
    expect(judgeIosRun({ status: "in_progress", conclusion: null }, [])).toEqual({ kind: "running" });
  });
});

describe("タグ", () => {
  it("ビルド番号を取り出す", () => {
    expect(buildNumberFromTag("ios-testflight/42")).toBe(42);
    expect(buildNumberFromTag("ios-testflight/x")).toBeNull();
    expect(buildNumberFromTag("v1.0.0")).toBeNull();
  });
  it("最大のビルド番号を返す（文字列順ではなく数値順）", () => {
    expect(latestDeliveredBuild(["refs/tags/ios-testflight/9", "refs/tags/ios-testflight/10"])).toEqual({
      tag: "ios-testflight/10",
      buildNumber: 10,
    });
    expect(latestDeliveredBuild([])).toBeNull();
  });
});
