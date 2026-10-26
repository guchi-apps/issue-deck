import { describe, expect, it } from "vitest";

import { MERGE_JUDGEMENT_UNKNOWN } from "@/lib/github/check-rollup";
import { resolveReleaseProgressTrack, type ReleaseTrack } from "@/lib/release-progress-track";
import type { BranchFlowDeployState } from "@/types/branch-flow";
import type { PullRequestReleaseChecks, PullRequestSummary } from "@/types/pull-request";

type Track = Parameters<typeof resolveReleaseProgressTrack>[0];
type TrackPullRequest = NonNullable<Track["bumpPullRequest"]>;

const PASSED: PullRequestReleaseChecks = {
  aiReview: "passed",
  integration: "passed",
  enforced: true,
  started: { aiReview: false, integration: false, mac: false },
  integrationSetupGap: null,
};

function pr(overrides: Partial<PullRequestSummary> = {}): TrackPullRequest {
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
  } as TrackPullRequest;
}

function candidate(overrides: Partial<PullRequestSummary> = {}): TrackPullRequest {
  return pr({ baseRef: "main", headRef: "release-main/v1", releaseChecks: PASSED, ...overrides });
}

function deploy(overrides: Partial<BranchFlowDeployState>): BranchFlowDeployState {
  return { kind: "running", htmlUrl: null, runId: 1, manual: false, autoRetried: false, ...overrides } as BranchFlowDeployState;
}

const check = (status: string) => ({ status }) as PullRequestSummary["ciChecks"][number];

function states(track: ReleaseTrack | null) {
  return track?.steps.map((step) => step.state);
}

describe("resolveReleaseProgressTrack", () => {
  it("リリースが動いていなければnull", () => {
    expect(
      resolveReleaseProgressTrack({ bumpPullRequest: null, candidatePullRequest: null, mergeTarget: null, deploy: null }),
    ).toBeNull();
    // 成功したデプロイ・画面からの出し直しはリリースの工程として出さない
    for (const state of [deploy({ kind: "success" }), deploy({ manual: true })]) {
      expect(
        resolveReleaseProgressTrack({ bumpPullRequest: null, candidatePullRequest: null, mergeTarget: null, deploy: state }),
      ).toBeNull();
    }
  });

  it("バンプPRのCI実行中は、最初の区切りだけが回る", () => {
    const track = resolveReleaseProgressTrack({
      bumpPullRequest: pr({ ciState: "pending", ciChecks: [check("in_progress")] }),
      candidatePullRequest: null,
      mergeTarget: null,
      deploy: null,
    });
    expect(states(track)).toEqual(["running", "todo", "todo", "todo", "todo", "todo"]);
    expect(track?.headline).toMatchObject({ key: "bump", label: "バージョンバンプのCI実行中", tone: "running" });
    expect([track?.done, track?.total]).toEqual([0, 6]);
  });

  it("統合検証の実行中は、済んだ区切りを数え、全体レビューの完了待ちを後ろへ添える", () => {
    const track = resolveReleaseProgressTrack({
      bumpPullRequest: null,
      candidatePullRequest: candidate({
        releaseChecks: {
          ...PASSED,
          aiReview: "running",
          integration: "running",
          started: { aiReview: false, integration: true, mac: false },
          aiReviewStage: { kind: "awaiting_integration" },
        },
      }),
      mergeTarget: null,
      deploy: null,
    });
    expect(states(track)).toEqual(["done", "done", "running", "waiting", "todo", "todo"]);
    expect(track?.headline).toMatchObject({ key: "integration", label: "統合検証中", tone: "running" });
    expect(track?.others).toEqual(["統合検証の完了待ち"]);
    expect([track?.done, track?.total]).toEqual([2, 6]);
  });

  it("検証が揃ってマージを待つ区切りは琥珀（人の番）", () => {
    const track = resolveReleaseProgressTrack({
      bumpPullRequest: null,
      candidatePullRequest: candidate(),
      mergeTarget: "main",
      deploy: null,
    });
    expect(states(track)).toEqual(["done", "done", "done", "done", "user", "todo"]);
    expect(track?.headline).toMatchObject({ label: "mainへマージ待ち", tone: "user" });
  });

  it("失敗は実行中より優先して見出しにし、理由を補足に入れる", () => {
    const track = resolveReleaseProgressTrack({
      bumpPullRequest: null,
      candidatePullRequest: candidate({
        ciState: "pending",
        ciChecks: [check("in_progress")],
        releaseChecks: { ...PASSED, integration: "failed" },
      }),
      mergeTarget: null,
      deploy: null,
    });
    expect(states(track)).toEqual(["done", "running", "failed", "done", "todo", "todo"]);
    expect(track?.headline).toMatchObject({ key: "integration", label: "統合検証が失敗", tone: "failed" });
    expect(track?.headline?.title).toBe("統合検証が失敗しています");
    expect(track?.others).toEqual(["リリース候補のCI実行中"]);
  });

  it("判断済み（#4814）の要確認は済みとして数え、赤にしない", () => {
    const track = resolveReleaseProgressTrack({
      bumpPullRequest: null,
      candidatePullRequest: candidate({
        releaseChecks: {
          ...PASSED,
          aiReview: "needs_check",
          aiReviewStage: { kind: "needs_check", autoReevaluated: false, items: ["findings"], cleared: true },
        },
      }),
      mergeTarget: null,
      deploy: null,
    });
    expect(track?.steps.find((step) => step.key === "review")?.state).toBe("done");
  });

  it("検証の記録を読めないときは推測で済みにしない", () => {
    const track = resolveReleaseProgressTrack({
      bumpPullRequest: null,
      candidatePullRequest: candidate({ releaseChecks: { ...PASSED, unavailable: true } }),
      mergeTarget: null,
      deploy: null,
    });
    expect(states(track)?.slice(2, 4)).toEqual(["todo", "todo"]);
  });

  it("旧方式の候補では統合検証・全体レビューを対象外にし、分母から外す", () => {
    const track = resolveReleaseProgressTrack({
      bumpPullRequest: null,
      candidatePullRequest: pr({ baseRef: "main", headRef: "develop" }),
      mergeTarget: "main",
      deploy: null,
    });
    expect(states(track)).toEqual(["done", "done", "skipped", "skipped", "user", "todo"]);
    expect([track?.done, track?.total]).toEqual([2, 4]);
  });

  it("マージ後のデプロイは最後の区切りが引き継ぐ", () => {
    const running = resolveReleaseProgressTrack({
      bumpPullRequest: null,
      candidatePullRequest: null,
      mergeTarget: null,
      deploy: deploy({ kind: "running" }),
    });
    expect(states(running)).toEqual(["done", "done", "done", "done", "done", "running"]);
    expect(running?.headline?.label).toBe("本番反映中");

    const failed = resolveReleaseProgressTrack({
      bumpPullRequest: null,
      candidatePullRequest: null,
      mergeTarget: null,
      deploy: deploy({ kind: "failure", autoRetried: true }),
    });
    expect(failed?.headline).toMatchObject({ label: "再デプロイも失敗", tone: "failed" });
  });

  it("公開承認済みの候補は、マージ待ちを人が押す番（user）でなく自動進行（running）で出す（#5064）", () => {
    const approved = candidate({ releaseChecks: { ...PASSED, publishApproved: true } });
    const track = resolveReleaseProgressTrack({
      bumpPullRequest: null,
      candidatePullRequest: approved,
      mergeTarget: null,
      deploy: null,
    });
    const merge = track?.steps.find((step) => step.key === "merge");
    expect(merge).toMatchObject({ state: "running", status: "自動でmainへマージ待ち" });
    expect(track?.headline?.tone).toBe("running");

    // 承認が無ければ従来どおり人が押す番
    const plain = resolveReleaseProgressTrack({
      bumpPullRequest: null,
      candidatePullRequest: candidate(),
      mergeTarget: "main",
      deploy: null,
    });
    expect(plain?.steps.find((step) => step.key === "merge")?.state).toBe("user");
  });
});
