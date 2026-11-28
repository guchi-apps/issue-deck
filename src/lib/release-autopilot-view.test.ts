import { describe, expect, it } from "vitest";

import { describeAutoPublishView, type AutoPublishViewInput } from "@/lib/release-autopilot-view";

function input(overrides: Partial<AutoPublishViewInput> = {}): AutoPublishViewInput {
  return {
    phase: "review",
    autoPublish: { active: true, stopCode: null, stopReason: null },
    importing: false,
    productionStopped: false,
    verification: null,
    ...overrides,
  };
}

const stopped = (stopCode: string) => ({ active: false, stopCode, stopReason: "理由" });

describe("describeAutoPublishView", () => {
  it("公開承認の工程を出さない", () => {
    const view = describeAutoPublishView(input())!;
    expect(view.steps.map((step) => step.label)).toEqual(["候補を作成", "検証と修正", "最終検証", "mainマージ", "本番反映", "稼働確認"]);
  });

  it("mainマージ前に動いている間は手動の操作を出さず、止める操作だけを出す", () => {
    for (const phase of ["creating", "review", "preparing", "awaiting_approval"]) {
      expect(describeAutoPublishView(input({ phase }))).toMatchObject({ mode: "running", hideManual: true, canStop: true, resume: null });
    }
    expect(describeAutoPublishView(input({ phase: "deploying" }))).toMatchObject({ hideManual: false, canStop: false });
  });

  it("停止したら手動の操作を戻し、理由に応じた再開を出す", () => {
    expect(describeAutoPublishView(input({ autoPublish: stopped("integration_environment") }))).toMatchObject({
      mode: "stopped",
      hideManual: false,
      resume: { rerun: "integration" },
    });
    expect(describeAutoPublishView(input({ autoPublish: stopped("review_unverified") }))!.resume?.rerun).toBe("review");
    expect(describeAutoPublishView(input({ autoPublish: stopped("run_stopped") }))!.resume).toMatchObject({ rerun: null });
    expect(describeAutoPublishView(input({ autoPublish: stopped("main_advanced") }))!.resume).toBeNull();
  });

  it("対象でない候補・取り消した候補は出さない", () => {
    expect(describeAutoPublishView(input({ autoPublish: null }))).toBeNull();
    expect(describeAutoPublishView(input({ phase: "cancelled" }))).toBeNull();
  });
});
