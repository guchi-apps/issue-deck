import { describe, expect, it } from "vitest";

import { applyReleasePrepState, isAwaitingReleaseAutomation, resolveReleasePrepState } from "@/lib/release-prep-state";

describe("resolveReleasePrepState", () => {
  it("記録が無ければidle（本番マージ直後の待機も推測しない）", () => {
    expect(resolveReleasePrepState({ hasOpenFailure: false, activeFixSeriesStatuses: [] })).toBe("idle");
    expect(resolveReleasePrepState({ hasOpenFailure: false, activeFixSeriesStatuses: ["ready", "stopped"] })).toBe("idle");
  });
  it("作り直し・修正取り込み後はrunning", () => {
    expect(resolveReleasePrepState({ hasOpenFailure: false, activeFixSeriesStatuses: ["rebuilding"] })).toBe("running");
    expect(resolveReleasePrepState({ hasOpenFailure: false, activeFixSeriesStatuses: ["fix_merged"] })).toBe("running");
  });
  it("失敗は準備中より優先する", () => {
    expect(resolveReleasePrepState({ hasOpenFailure: true, activeFixSeriesStatuses: ["rebuilding"] })).toBe("failed");
  });
});

describe("applyReleasePrepState", () => {
  it("押せる状態にだけ重ね、既存の理由は上書きしない", () => {
    expect(applyReleasePrepState(null, "running")).toBe("release-preparing");
    expect(applyReleasePrepState(null, "failed")).toBe("preparation-failed");
    expect(applyReleasePrepState(null, "idle")).toBeNull();
    expect(applyReleasePrepState("deploy-failed", "running")).toBe("deploy-failed");
    expect(applyReleasePrepState("release-in-progress", "failed")).toBe("release-in-progress");
  });
});

describe("isAwaitingReleaseAutomation（#4526）", () => {
  const now = Date.parse("2026-10-12T10:00:00Z");
  const base = { now, unreleasedCommitCount: 1 };
  it("本番マージ直後で未リリースの変更があれば待機", () => {
    expect(isAwaitingReleaseAutomation({ ...base, latestReleaseMergedAt: "2026-10-12T09:50:00Z" })).toBe(true);
  });
  it("待機時間を過ぎれば待機ではない", () => {
    expect(isAwaitingReleaseAutomation({ ...base, latestReleaseMergedAt: "2026-10-12T09:30:00Z" })).toBe(false);
  });
  it("未リリースの変更が無い・マージ時刻が無いなら待機ではない", () => {
    expect(isAwaitingReleaseAutomation({ ...base, unreleasedCommitCount: 0, latestReleaseMergedAt: "2026-10-12T09:55:00Z" })).toBe(false);
    expect(isAwaitingReleaseAutomation({ ...base, latestReleaseMergedAt: null })).toBe(false);
  });
});
