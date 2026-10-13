import { describe, expect, it } from "vitest";

import { MERGE_JUDGEMENT_UNKNOWN } from "@/lib/github/check-rollup";
import { resolveReleaseStageBadges } from "@/lib/release-stage-badges";
import type { PullRequestReleaseChecks, PullRequestSummary } from "@/types/pull-request";

type Stage = Parameters<typeof resolveReleaseStageBadges>[0]["bumpPullRequest"];

const PASSED: PullRequestReleaseChecks = {
  aiReview: "passed",
  integration: "passed",
  enforced: true,
  started: { aiReview: false, integration: false, mac: false },
  integrationSetupGap: null,
};

function pr(overrides: Partial<PullRequestSummary> = {}): NonNullable<Stage> {
  return {
    state: "open",
    baseRef: "develop",
    headRef: "release-bump/v1",
    ciState: "success",
    ciChecks: [],
    mergeJudgement: MERGE_JUDGEMENT_UNKNOWN,
    releaseChecks: null,
    iosPrecheck: null,
    ...overrides,
  } as NonNullable<Stage>;
}

function candidate(overrides: Partial<PullRequestSummary> = {}): NonNullable<Stage> {
  return pr({ baseRef: "main", headRef: "release-main/v1", releaseChecks: PASSED, ...overrides });
}

const check = (status: string) => ({ status }) as PullRequestSummary["ciChecks"][number];

describe("resolveReleaseStageBadges", () => {
  it("バンプPRのCI実行中は、工程名つきで回る", () => {
    const badges = resolveReleaseStageBadges({
      bumpPullRequest: pr({ ciState: "pending", ciChecks: [check("in_progress")] }),
      candidatePullRequest: null,
    });
    expect(badges).toEqual([expect.objectContaining({ label: "バージョンバンプのCI実行中", running: true })]);
  });

  it("CIがキュー待ちだけなら回さない。根拠が無ければ未完了と言い、実行中とは言わない", () => {
    const queued = resolveReleaseStageBadges({
      bumpPullRequest: null,
      candidatePullRequest: candidate({ ciState: "pending", ciChecks: [check("queued")] }),
    });
    expect(queued).toEqual([expect.objectContaining({ label: "リリース候補のCI待機", running: false })]);
    const unknown = resolveReleaseStageBadges({
      bumpPullRequest: null,
      candidatePullRequest: candidate({ ciState: "pending", ciChecks: [] }),
    });
    expect(unknown).toEqual([expect.objectContaining({ label: "リリース候補のCI未完了", running: false })]);
  });

  it("全体レビューと統合検証が並行しているとき、両方を別々に出す（CIとは数えない）", () => {
    const badges = resolveReleaseStageBadges({
      bumpPullRequest: null,
      candidatePullRequest: candidate({
        releaseChecks: {
          ...PASSED,
          aiReview: "running",
          integration: "running",
          started: { aiReview: true, integration: true, mac: false },
        },
      }),
    });
    expect(badges.map((b) => [b.label, b.running])).toEqual([
      ["全体レビュー中", true],
      ["統合検証中", true],
    ]);
  });

  it("開始待ちの検証は回さない", () => {
    const badges = resolveReleaseStageBadges({
      bumpPullRequest: null,
      candidatePullRequest: candidate({ releaseChecks: { ...PASSED, integration: "running" } }),
    });
    expect(badges).toEqual([expect.objectContaining({ label: "統合検証開始待ち", running: false })]);
  });

  it("iOS事前検証は別系統。headの結果だけを使い、previousは混ぜない", () => {
    const running = resolveReleaseStageBadges({
      bumpPullRequest: null,
      candidatePullRequest: candidate({
        iosPrecheck: {
          headSha: "b",
          head: { phase: "running", description: "iOS検証: ビルド中", sha: "b", updatedAt: null },
          previous: null,
        },
      }),
    });
    expect(running).toEqual([expect.objectContaining({ label: "iOS検証中", running: true })]);
    const stale = resolveReleaseStageBadges({
      bumpPullRequest: null,
      candidatePullRequest: candidate({
        iosPrecheck: {
          headSha: "b",
          head: null,
          previous: { phase: "running", description: null, sha: "a", updatedAt: null },
        },
      }),
    });
    expect(stale).toEqual([]);
  });

  it("成功・失敗・マージ判定が無ければ工程を出さない。閉じたPRも出さない", () => {
    expect(resolveReleaseStageBadges({ bumpPullRequest: pr(), candidatePullRequest: candidate() })).toEqual([]);
    expect(
      resolveReleaseStageBadges({
        bumpPullRequest: pr({ state: "closed", ciState: "pending", ciChecks: [check("in_progress")] }),
        candidatePullRequest: null,
      }),
    ).toEqual([]);
  });
});
