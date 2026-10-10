import { describe, expect, it } from "vitest";

import {
  buildReleaseVerificationProgress,
  formatReleaseElapsed,
  formatReleaseReviewAgent,
  parseReleaseProgress,
  viewReleaseProgress,
  type ReleaseProgressJobSource,
} from "./release-verification-progress";

const T0 = new Date("2026-10-10T09:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const STALL = 10 * 60 * 1000;

function job(overrides: Partial<ReleaseProgressJobSource> = {}): ReleaseProgressJobSource {
  return {
    status: "QUEUED",
    targetHost: "subpc",
    claimedByHost: null,
    createdAt: T0,
    claimedAt: null,
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    message: null,
    progress: null,
    ...overrides,
  };
}

const PLAN = ["prepare", "merge", "install", "test", "build", "mac"];

describe("parseReleaseProgress", () => {
  it("区分に無い工程名・計画と食い違う位置は捨てる", () => {
    expect(parseReleaseProgress("integration", { step: "review" })).toBeNull();
    expect(parseReleaseProgress("ai_review", { step: "test" })).toBeNull();
    expect(parseReleaseProgress("integration", { step: "<script>" })).toBeNull();
    // 位置が計画の別の工程を指している
    expect(parseReleaseProgress("integration", { step: "test", plan: PLAN, index: 2 })?.index).toBeNull();
    // 計画に知らない工程が混ざっていれば計画ごと捨てる
    expect(parseReleaseProgress("integration", { step: "test", plan: ["prepare", "rm -rf"], index: 0 })?.plan).toBeNull();
  });

  it("検証コマンドは統合検証だけ、差分のファイル数は全体レビューだけ受け取る", () => {
    expect(parseReleaseProgress("integration", { step: "test", command: " pnpm test ", files: 3 })).toEqual({
      step: "test",
      plan: null,
      index: null,
      command: "pnpm test",
      files: null,
    });
    expect(parseReleaseProgress("ai_review", { step: "review", command: "x", files: 42 })?.files).toBe(42);
    expect(parseReleaseProgress("ai_review", { step: "review", command: "x" })?.command).toBeNull();
  });
});

describe("buildReleaseVerificationProgress", () => {
  it("計画の中の位置と、検証コマンドの何件目かを出す", () => {
    const progress = buildReleaseVerificationProgress({
      kind: "integration",
      job: job({ status: "RUNNING", progress: { step: "test", plan: PLAN, index: 3, command: "pnpm test" } }),
      hostOnline: true,
      stalledAfterMs: STALL,
    });
    expect(progress.steps.map((s) => s.label)).toEqual(["準備", "統合", "依存関係取得", "テスト", "ビルド", "Mac検証"]);
    expect(progress.currentIndex).toBe(3);
    expect(progress.commandPosition).toEqual({ index: 2, total: 3 });
    // 実行中は実行側の文面を理由として出さない（終了したときだけ）
    expect(progress.message).toBeNull();
  });

  it("工程の報告が無ければ現在位置は未取得（null）", () => {
    const progress = buildReleaseVerificationProgress({
      kind: "ai_review",
      job: job({ status: "RUNNING" }),
      hostOnline: true,
      stalledAfterMs: STALL,
    });
    expect(progress.currentIndex).toBeNull();
    expect(progress.steps.map((s) => s.key)).toEqual(["prepare", "diff", "review", "finalize"]);
  });

  it("全体レビューの担当はジョブの記録から作る", () => {
    const progress = buildReleaseVerificationProgress({
      kind: "ai_review",
      job: job({ agent: "codex", codexModel: "gpt-6-sol", claudeModel: null }),
      hostOnline: null,
      stalledAfterMs: STALL,
    });
    expect(progress.agent).toBe("codex:gpt-6-sol");
    expect(formatReleaseReviewAgent(progress.agent ?? "")).toBe("Codex · gpt-6-sol");
    expect(formatReleaseReviewAgent("claude:opus")).toBe("Claude Code · opus");
  });
});

describe("viewReleaseProgress", () => {
  const build = (overrides: Partial<ReleaseProgressJobSource>, hostOnline: boolean | null = true) =>
    buildReleaseVerificationProgress({ kind: "integration", job: job(overrides), hostOnline, stalledAfterMs: STALL });

  it("待機中は実行先の状態から理由を出し、分からなければnull（未取得）", () => {
    expect(viewReleaseProgress(build({}, false), at(840).getTime())).toMatchObject({
      phase: "queued",
      waitingReason: "実行先 subpc がオフラインです",
      elapsedMs: 840_000,
    });
    expect(viewReleaseProgress(build({}, true), at(10).getTime()).waitingReason).toBe("順番待ち（subpc の受け取り待ち）");
    expect(viewReleaseProgress(build({}, null), at(10).getTime()).waitingReason).toBeNull();
  });

  it("受け取り済みで動き出す前は起動準備中", () => {
    const view = viewReleaseProgress(
      build({ status: "CLAIMED", claimedByHost: "subpc", claimedAt: at(60) }),
      at(80).getTime(),
    );
    expect(view).toMatchObject({ phase: "starting", waitingReason: "起動準備中（subpc が受け取り済み）" });
  });

  it("実行中は工程名と開始からの経過を出す", () => {
    const view = viewReleaseProgress(
      build({
        status: "RUNNING",
        startedAt: at(60),
        heartbeatAt: at(300),
        progress: { step: "test", plan: PLAN, index: 3 },
      }),
      at(305).getTime(),
    );
    expect(view).toMatchObject({
      phase: "running",
      stepLabel: "テスト（検証コマンド 2/3）",
      elapsedMs: 245_000,
      sinceLastReportMs: 5_000,
    });
  });

  it("報告が途絶えたら実行中のまま見せず、応答なしにする", () => {
    const view = viewReleaseProgress(
      build({ status: "RUNNING", startedAt: at(0), heartbeatAt: at(60), progress: { step: "build", plan: PLAN, index: 4 } }),
      at(60 + 11 * 60).getTime(),
    );
    expect(view.phase).toBe("stalled");
    expect(view.stepLabel).toBe("ビルド（検証コマンド 3/3）");
  });

  it("取り消し・終了は区別し、終了後は所要時間を出す", () => {
    expect(viewReleaseProgress(build({ status: "CANCELED", finishedAt: at(30) }), at(100).getTime()).phase).toBe(
      "canceled",
    );
    const ended = viewReleaseProgress(
      build({ status: "SUCCEEDED", startedAt: at(0), finishedAt: at(460), message: "統合検証を完了しました" }),
      at(9999).getTime(),
    );
    expect(ended).toMatchObject({ phase: "ended", elapsedMs: 460_000 });
  });
});

describe("formatReleaseElapsed", () => {
  it("秒・分秒・時間分で出す", () => {
    expect(formatReleaseElapsed(12_400)).toBe("12秒");
    expect(formatReleaseElapsed(245_000)).toBe("4分05秒");
    expect(formatReleaseElapsed(3_720_000)).toBe("1時間2分");
  });
});
