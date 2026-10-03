import { describe, expect, it } from "vitest";

import {
  buildNumberFromTag,
  checkIosDispatchable,
  deliveredBuildForSha,
  isIosDistributionPending,
  judgeIosReleasePanel,
  toWebDeployState,
  judgeIosRun,
  latestDeliveredBuild,
  summarizeIosStages,
  toStageState,
  type IosReleasePanelInput,
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

describe("deliveredBuildForSha（タグが指すコミットから配布済みを引く）", () => {
  const refs = [
    { ref: "refs/tags/ios-testflight/201", sha: "aaa" },
    { ref: "refs/tags/ios-testflight/305", sha: "bbb" },
    { ref: "refs/tags/ios-testflight/306", sha: "aaa" },
    { ref: "refs/tags/ios-testflight/x", sha: "aaa" },
  ];
  it("一致するコミットの最大のビルド番号を返す", () => {
    expect(deliveredBuildForSha(refs, "aaa")).toBe(306);
    expect(deliveredBuildForSha(refs, "bbb")).toBe(305);
  });
  it("タグが無いコミットはnull", () => {
    expect(deliveredBuildForSha(refs, "ccc")).toBeNull();
  });
});

describe("judgeIosReleasePanel", () => {
  const base = { webDeploy: "success", isMainTip: true, deliveredBuild: null, runs: [], sha: "aaa" } as const;
  const run = (over: Partial<IosReleasePanelInput["runs"][number]>): IosReleasePanelInput["runs"][number] => ({
    status: "completed",
    headSha: "aaa",
    verdict: { kind: "unknown" },
    stages: [],
    ...over,
  });

  it("配布済みはタグで決まり、古い束でも出る", () => {
    expect(judgeIosReleasePanel({ ...base, isMainTip: false, deliveredBuild: 12 })).toEqual({
      kind: "delivered",
      buildNumber: 12,
    });
  });
  it("Webのデプロイが済むまでは操作できない（失敗はfailed=true）", () => {
    expect(judgeIosReleasePanel({ ...base, webDeploy: "pending" })).toEqual({ kind: "awaiting-web", failed: false });
    expect(judgeIosReleasePanel({ ...base, webDeploy: "failed" })).toEqual({ kind: "awaiting-web", failed: true });
  });
  it("mainの先端でない束は操作できない", () => {
    expect(judgeIosReleasePanel({ ...base, isMainTip: false })).toEqual({ kind: "stale" });
  });
  it("実行中のrunがあれば配布中", () => {
    const state = judgeIosReleasePanel({
      ...base,
      runs: [run({ status: "in_progress", verdict: { kind: "running" } })],
    });
    expect(state.kind).toBe("running");
  });
  it("更新不要は失敗ではない", () => {
    expect(judgeIosReleasePanel({ ...base, runs: [run({ verdict: { kind: "skipped" } })] })).toEqual({
      kind: "not-needed",
    });
  });
  it("失敗は失敗段階つき。別コミットのrunは対象外", () => {
    expect(
      judgeIosReleasePanel({ ...base, runs: [run({ verdict: { kind: "failed", failedStage: "署名" } })] }),
    ).toEqual({ kind: "failed", failedStage: "署名" });
    expect(
      judgeIosReleasePanel({ ...base, runs: [run({ headSha: "zzz", verdict: { kind: "failed", failedStage: "署名" } })] }),
    ).toEqual({ kind: "ready" });
  });
  it("runが無ければ未配布（起動できる）", () => {
    expect(judgeIosReleasePanel(base)).toEqual({ kind: "ready" });
  });
});

describe("toWebDeployState / checkIosDispatchable", () => {
  it("デプロイのrunを3値へ寄せる", () => {
    expect(toWebDeployState(null)).toBe("pending");
    expect(toWebDeployState({ status: "in_progress", conclusion: null })).toBe("pending");
    expect(toWebDeployState({ status: "completed", conclusion: "success" })).toBe("success");
    expect(toWebDeployState({ status: "completed", conclusion: "failure" })).toBe("failed");
  });
  const ok = { merged: true, isMainTip: true, webDeploy: "success", deliveredBuild: null, hasActiveRun: false } as const;
  it("すべて満たせば起動できる", () => {
    expect(checkIosDispatchable(ok)).toBeNull();
  });
  it("満たさない条件ごとに理由を返す", () => {
    expect(checkIosDispatchable({ ...ok, merged: false })).toBe("not_merged");
    expect(checkIosDispatchable({ ...ok, isMainTip: false })).toBe("not_main_tip");
    expect(checkIosDispatchable({ ...ok, webDeploy: "pending" })).toBe("deploy_not_succeeded");
    expect(checkIosDispatchable({ ...ok, deliveredBuild: 3 })).toBe("already_delivered");
    expect(checkIosDispatchable({ ...ok, hasActiveRun: true })).toBe("run_in_progress");
  });
});

describe("summarizeIosStages の時刻", () => {
  it("同じ段階のジョブ・ステップは最も早い開始と最も遅い終了へ畳む", () => {
    const stages = summarizeIosStages([
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-30T14:00:00Z",
        completed_at: "2026-09-30T14:04:00Z",
      },
    ]);
    const build = stages.find((s) => s.key === "build");
    expect(build?.startedAt).toBe("2026-09-30T14:00:00Z");
    expect(build?.completedAt).toBe("2026-09-30T14:04:00Z");
    expect(stages.find((s) => s.key === "sign")?.startedAt).toBeNull();
  });
});

describe("isIosDistributionPending", () => {
  it("配布が済んでいない状態だけ斜線の対象にする", () => {
    expect(isIosDistributionPending({ kind: "ready" })).toBe(true);
    expect(isIosDistributionPending({ kind: "failed", failedStage: null })).toBe(true);
    expect(isIosDistributionPending({ kind: "awaiting-web", failed: false })).toBe(true);
    expect(isIosDistributionPending({ kind: "running", stages: [] })).toBe(true);
  });

  it("配布済み・更新不要・判定できない版・読み込み前は対象にしない", () => {
    expect(isIosDistributionPending({ kind: "delivered", buildNumber: 3 })).toBe(false);
    expect(isIosDistributionPending({ kind: "not-needed" })).toBe(false);
    expect(isIosDistributionPending({ kind: "stale" })).toBe(false);
    expect(isIosDistributionPending(null)).toBe(false);
  });
});
