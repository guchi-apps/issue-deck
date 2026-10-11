import { describe, expect, it } from "vitest";

import {
  describeReleaseVerificationWait,
  isReleaseCandidateClear,
  releaseChecksFromSummary,
  releaseVerificationBlock,
  resolvePullRequestReleaseVerification,
  resolveReleaseCandidateVerification,
} from "@/lib/release-candidate-status";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";
import type { PullRequestReleaseChecks } from "@/types/pull-request";

const PASSED: PullRequestReleaseChecks = {
  aiReview: "passed",
  integration: "passed",
  enforced: true,
  started: { aiReview: false, integration: false, mac: false },
  integrationSetupGap: null,
};

function resolve(overrides: Partial<PullRequestReleaseChecks>) {
  return resolveReleaseCandidateVerification({ ...PASSED, ...overrides }, true);
}

describe("resolveReleaseCandidateVerification", () => {
  it("両方合格（または対象外）ならclearで、mainへマージ待ちを出してよい", () => {
    expect(isReleaseCandidateClear(resolve({}))).toBe(true);
    expect(isReleaseCandidateClear(resolve({ integration: "not_applicable" }))).toBe(true);
  });

  it("#554相当: 全体レビューが実行中ならリリース検証中で、マージ待ちにしない", () => {
    const v = resolve({
      aiReview: "running",
      integration: "not_applicable",
      enforced: false,
      started: { aiReview: true, integration: false, mac: false },
    });
    expect(v.progress?.label).toBe("リリース検証中");
    expect(v.problem).toBeNull();
    expect(isReleaseCandidateClear(v)).toBe(false);
    expect(describeReleaseVerificationWait(v)).toBe("全体レビュー（実行中）の判定が出るまでマージできません");
  });

  it("両方が待機中ならリリース検証待ち、一方でも動いていればリリース検証中", () => {
    expect(resolve({ aiReview: "running", integration: "running" }).progress?.label).toBe("リリース検証待ち");
    const oneRunning = resolve({
      aiReview: "running",
      integration: "running",
      started: { aiReview: false, integration: true, mac: false },
    });
    expect(oneRunning.progress?.label).toBe("リリース検証中");
    expect(oneRunning.detail).toBe("全体レビューの開始待ちです。統合検証の実行中です");
  });

  it("一方だけ完了・もう一方が待機中も、待っている検証の名前を出してマージ待ちにしない", () => {
    const v = resolve({ integration: "running" });
    expect(v.progress?.checks).toEqual([{ name: "統合検証", started: false }]);
    expect(describeReleaseVerificationWait(v)).toBe("統合検証（開始待ち）の判定が出るまでマージできません");
  });

  it("Mac検証の工程にいる統合検証はMac検証と分かる名前にする", () => {
    const v = resolve({ integration: "running", started: { aiReview: false, integration: true, mac: true } });
    expect(v.progress?.checks[0].name).toBe("統合検証（Mac検証）");
  });

  it("失敗・設定不足・要確認・対象変更を理由付きで分け、いちばん重いものを見出しにする", () => {
    expect(resolve({ aiReview: "failed" }).problem).toEqual({
      kind: "failed",
      label: "検証失敗",
      reasons: ["全体レビューが失敗しています"],
    });
    expect(resolve({ integration: "failed", integrationSetupGap: "コマンド未設定" }).problem).toEqual({
      kind: "setup_missing",
      label: "検証の設定不足",
      reasons: ["統合検証: コマンド未設定"],
    });
    expect(resolve({ aiReview: "needs_check" }).problem?.label).toBe("検証要確認");
    expect(resolve({ integration: "invalidated" }).problem?.label).toBe("再検証が必要");
    const both = resolve({ aiReview: "needs_check", integration: "failed" });
    expect(both.problem?.label).toBe("検証失敗");
    expect(both.problem?.reasons).toHaveLength(2);
  });

  it("問題と進行が同時にあるときは両方を返す（問題を隠さない）", () => {
    const v = resolve({ aiReview: "failed", integration: "running" });
    expect(v.problem?.kind).toBe("failed");
    expect(v.progress?.checks).toHaveLength(1);
    expect(releaseVerificationBlock(v)).toBe("problem");
  });

  it("未実施は強制しているときだけ問題にする（#4354と同じく、依頼されていないものは待たない）", () => {
    expect(resolve({ aiReview: "not_run" }).problem?.kind).toBe("not_run");
    expect(isReleaseCandidateClear(resolve({ aiReview: "not_run", enforced: false }))).toBe(true);
  });

  it("記録が無い・読めなかった候補は取得不能で、マージ待ちにしない", () => {
    expect(resolveReleaseCandidateVerification(null, true).problem?.kind).toBe("unavailable");
    expect(resolveReleaseCandidateVerification({ ...PASSED, unavailable: true }, true).problem?.kind).toBe(
      "unavailable",
    );
  });

  it("リリース候補でないPR（旧世代のリリースPR）は検証を見ない", () => {
    expect(isReleaseCandidateClear(resolveReleaseCandidateVerification(null, false))).toBe(true);
  });
});

describe("resolvePullRequestReleaseVerification", () => {
  it("base=main・head=release-main/v*のopenなPRだけを候補として判定する", () => {
    const candidate = { baseRef: "main", headRef: "release-main/v1.2.3", state: "open" as const };
    expect(resolvePullRequestReleaseVerification({ ...candidate, releaseChecks: null }).problem?.kind).toBe(
      "unavailable",
    );
    expect(
      isReleaseCandidateClear(resolvePullRequestReleaseVerification({ ...candidate, state: "closed" })),
    ).toBe(true);
    expect(
      isReleaseCandidateClear(resolvePullRequestReleaseVerification({ baseRef: "main", headRef: "develop" })),
    ).toBe(true);
  });
});

describe("releaseChecksFromSummary", () => {
  it("リリース画面の要約から、待機中と実行中を分けて畳む", () => {
    const section = (state: string) => ({ state }) as ReleaseVerificationSummary["integration"];
    const summary = {
      enforced: false,
      aiReview: section("running"),
      integration: section("waiting"),
      mac: { state: "not_applicable" },
    } as unknown as ReleaseVerificationSummary;
    const checks = releaseChecksFromSummary(summary);
    expect(checks).toMatchObject({
      aiReview: "running",
      integration: "running",
      started: { aiReview: true, integration: false, mac: false },
    });
    expect(resolveReleaseCandidateVerification(checks, true).progress?.label).toBe("リリース検証中");
  });
});
