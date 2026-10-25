import { describe, expect, it } from "vitest";

import { decideIntegrationResume, describeIntegrationResume } from "@/lib/release-integration-rerun-view";
import type { ReleaseVerificationProgress } from "@/lib/release-verification-progress";

const NOW = Date.parse("2026-10-25T10:00:00Z");

function progress(over: Partial<ReleaseVerificationProgress>): ReleaseVerificationProgress {
  return {
    jobStatus: "running",
    host: "subpc",
    hostOnline: true,
    requestedAt: "2026-10-25T09:00:00Z",
    claimedAt: "2026-10-25T09:00:10Z",
    startedAt: "2026-10-25T09:00:10Z",
    lastReportAt: "2026-10-25T09:59:50Z",
    finishedAt: null,
    message: null,
    steps: [],
    currentIndex: null,
    commandPosition: null,
    command: null,
    files: null,
    agent: null,
    stalledAfterMs: 10 * 60 * 1000,
    ...over,
  };
}

describe("decideIntegrationResume", () => {
  it("取り消されたジョブで待機のままの行は再開できる", () => {
    const p = progress({ jobStatus: "canceled", finishedAt: "2026-10-25T09:30:00Z" });
    expect(decideIntegrationResume({ state: "waiting", progress: p, nowMs: NOW })).toEqual({ ok: true, reason: "interrupted" });
  });

  it("結果が記録されないまま終了したジョブも再開できる", () => {
    const p = progress({ jobStatus: "succeeded", finishedAt: "2026-10-25T09:30:00Z" });
    expect(decideIntegrationResume({ state: "running", progress: p, nowMs: NOW }).ok).toBe(true);
  });

  it("ジョブが無いまま待っている行は再開できる", () => {
    expect(decideIntegrationResume({ state: "waiting", progress: null, nowMs: NOW })).toEqual({ ok: true, reason: "no_job" });
  });

  it("失敗は再開できる", () => {
    expect(decideIntegrationResume({ state: "failed", progress: null, nowMs: NOW })).toEqual({ ok: true, reason: "failed" });
  });

  it("実行中・待機中のジョブがある行は再開できない", () => {
    expect(decideIntegrationResume({ state: "running", progress: progress({}), nowMs: NOW })).toEqual({ ok: false, reason: "in_progress" });
    expect(decideIntegrationResume({ state: "waiting", progress: progress({ jobStatus: "queued" }), nowMs: NOW }).ok).toBe(false);
  });

  it("応答なし（報告が途絶えた実行中ジョブ）は生きているので再開できない", () => {
    const p = progress({ lastReportAt: "2026-10-25T09:00:20Z" });
    expect(decideIntegrationResume({ state: "running", progress: p, nowMs: NOW })).toEqual({ ok: false, reason: "in_progress" });
  });

  it("合格・要確認・対象外・無効・未実施は再開できない", () => {
    for (const state of ["passed", "needs_check", "not_applicable", "invalidated", "not_run"] as const) {
      expect(decideIntegrationResume({ state: state as never, progress: null, nowMs: NOW })).toEqual({ ok: false, reason: "finished" });
    }
  });
});

describe("describeIntegrationResume", () => {
  it("中断では案内とボタン名を返し、対象外では何も出さない", () => {
    const p = progress({ jobStatus: "canceled", finishedAt: "2026-10-25T09:30:00Z" });
    expect(describeIntegrationResume({ state: "waiting", progress: p }, NOW)).toMatchObject({ kind: "ready", buttonLabel: "統合検証を再開" });
    expect(describeIntegrationResume({ state: "passed", progress: null }, NOW)).toEqual({ kind: "none" });
  });
});
