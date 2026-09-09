import { describe, expect, it } from "vitest";

import type { AiReviewState, MergeJudgement, MergeJudgementStep } from "@/lib/github/check-rollup";
import type { CiState } from "@/lib/github/release-api";
import {
  buildIssuePullRequestProgress,
  ciStateFromPullRequestCiStatus,
  isPullRequestWaitingStatus,
  resolveIssuePullRequestProgress,
  resolvePullRequestPosition,
  selectProgressPullRequest,
  type IssuePullRequestProgressSource,
} from "@/lib/issue-pull-request-progress";

function judgement(options: {
  state?: MergeJudgement["state"];
  step?: MergeJudgementStep | null;
  aiReview?: AiReviewState;
}): MergeJudgement {
  return {
    state: options.state ?? "settled",
    step: options.step ?? null,
    runUrl: null,
    aiReview: { state: options.aiReview ?? "passed", runUrl: null },
  };
}

function pullRequest(
  overrides: Partial<IssuePullRequestProgressSource> = {},
): IssuePullRequestProgressSource {
  return {
    number: 100,
    state: "open",
    draft: false,
    merged: false,
    ciState: "success",
    mergeable: true,
    mergeJudgement: judgement({}),
    ...overrides,
  };
}

function labelOf(step: string, progress: ReturnType<typeof buildIssuePullRequestProgress>) {
  return progress.steps.find((entry) => entry.key === step);
}

describe("isPullRequestWaitingStatus", () => {
  it("PRを待っている段（Develop PR・Release）だけ真になる", () => {
    expect(isPullRequestWaitingStatus("develop-pr")).toBe(true);
    expect(isPullRequestWaitingStatus("release")).toBe(true);
    for (const status of ["ready", "planning", "implementation", "develop", "done", "closed"] as const) {
      expect(isPullRequestWaitingStatus(status)).toBe(false);
    }
  });
});

describe("ciStateFromPullRequestCiStatus", () => {
  it("対応PRのCI状態をCiStateへ戻す。取れていない（none・null）は unknown", () => {
    expect(ciStateFromPullRequestCiStatus("in_progress")).toBe<CiState>("pending");
    expect(ciStateFromPullRequestCiStatus("success")).toBe<CiState>("success");
    expect(ciStateFromPullRequestCiStatus("failure")).toBe<CiState>("failure");
    expect(ciStateFromPullRequestCiStatus("none")).toBe<CiState>("unknown");
    expect(ciStateFromPullRequestCiStatus(null)).toBe<CiState>("unknown");
  });
});

describe("selectProgressPullRequest", () => {
  it("開いているPRのうち番号が最大のものを選ぶ", () => {
    const selected = selectProgressPullRequest([
      pullRequest({ number: 10 }),
      pullRequest({ number: 30 }),
      pullRequest({ number: 20 }),
    ]);
    expect(selected?.number).toBe(30);
  });

  it("マージ済み・クローズ済みは選ばない", () => {
    expect(
      selectProgressPullRequest([
        pullRequest({ number: 40, state: "closed", merged: true }),
        pullRequest({ number: 20 }),
      ])?.number,
    ).toBe(20);
    expect(
      selectProgressPullRequest([pullRequest({ number: 40, state: "closed", merged: true })]),
    ).toBeNull();
  });
});

describe("buildIssuePullRequestProgress の待っているもの", () => {
  it("止まっているものを、動いているものより先に出す", () => {
    // コンフリクトはCIが通っていても解消されないので最優先
    expect(
      buildIssuePullRequestProgress(
        pullRequest({
          mergeable: false,
          ciState: "pending",
          mergeJudgement: judgement({ state: "pending", step: "claude-review", aiReview: "pending" }),
        }),
      ),
    ).toMatchObject({ label: "コンフリクトあり", tone: "attention" });

    expect(
      buildIssuePullRequestProgress(
        pullRequest({
          ciState: "failure",
          mergeJudgement: judgement({ state: "pending", step: "claude-review", aiReview: "pending" }),
        }),
      ),
    ).toMatchObject({ label: "CI失敗", tone: "attention" });

    expect(
      buildIssuePullRequestProgress(
        pullRequest({ mergeJudgement: judgement({ state: "pending", aiReview: "failed" }) }),
      ),
    ).toMatchObject({ label: "Claudeのレビュー失敗", tone: "attention" });
  });

  it("判定が動いている間は、判定の段の名前をCIより先に出す（#2066と同じ理由）", () => {
    expect(
      buildIssuePullRequestProgress(
        pullRequest({
          ciState: "pending",
          mergeJudgement: judgement({ state: "pending", step: "claude-review", aiReview: "pending" }),
        }),
      ),
    ).toMatchObject({ label: "Claudeがレビュー中", tone: "running" });
  });

  it("判定のcheck-runが無いリポジトリでは、CIの状態をそのまま出す", () => {
    expect(
      buildIssuePullRequestProgress(
        pullRequest({
          ciState: "pending",
          mergeJudgement: judgement({ state: "unknown", aiReview: "none" }),
        }),
      ),
    ).toMatchObject({ label: "CI実行中", tone: "running" });
  });

  it("判定もCIも終わって開いたままなら、人待ちの「マージ待ち」になる", () => {
    expect(buildIssuePullRequestProgress(pullRequest({}))).toMatchObject({
      label: "マージ待ち",
      tone: "waiting",
    });
  });

  it("下書きのPRは「下書き」。判定もCIも走っていないことを失敗として見せない", () => {
    expect(
      buildIssuePullRequestProgress(
        pullRequest({ draft: true, ciState: "unknown", mergeJudgement: judgement({ state: "unknown", aiReview: "none" }) }),
      ),
    ).toMatchObject({ label: "下書き", tone: "waiting" });
  });
});

describe("buildIssuePullRequestProgress の内訳", () => {
  it("PRが在ること自体を「実装完了」として済みにする", () => {
    const progress = buildIssuePullRequestProgress(pullRequest({}));
    expect(labelOf("opened", progress)).toEqual({
      key: "opened",
      label: "実装完了",
      shortLabel: "実装完了",
      state: "done",
    });
  });

  it("レビューの段は、判定のcheck-runが無いリポジトリでは並べない", () => {
    const withReview = buildIssuePullRequestProgress(
      pullRequest({ mergeJudgement: judgement({ aiReview: "skipped" }) }),
    );
    expect(withReview.steps.map((step) => step.key)).toEqual(["opened", "ci", "ai-review", "merge"]);

    const withoutReview = buildIssuePullRequestProgress(
      pullRequest({ mergeJudgement: judgement({ state: "unknown", aiReview: "none" }) }),
    );
    expect(withoutReview.steps.map((step) => step.key)).toEqual(["opened", "ci", "merge"]);
  });

  it("前の段が動いている間、マージの段は現在地にならない", () => {
    const reviewing = buildIssuePullRequestProgress(
      pullRequest({
        ciState: "pending",
        mergeJudgement: judgement({ state: "pending", step: "claude-review", aiReview: "pending" }),
      }),
    );
    expect(labelOf("ci", reviewing)?.state).toBe("current");
    expect(labelOf("ai-review", reviewing)?.state).toBe("current");
    expect(labelOf("merge", reviewing)?.state).toBe("pending");

    const settled = buildIssuePullRequestProgress(pullRequest({}));
    expect(labelOf("merge", settled)?.state).toBe("current");
  });

  it("CIが失敗した段は failed で止まる", () => {
    const failed = buildIssuePullRequestProgress(pullRequest({ ciState: "failure" }));
    expect(labelOf("ci", failed)).toEqual({
      key: "ci",
      label: "CI失敗",
      shortLabel: "CI失敗",
      state: "failed",
    });
  });

  // PR一覧のステータスレール（#2942）は幅が狭く、「Claudeのレビュー完了」は枠に収まらない。
  // 短縮版は主語を落としただけで、状態の呼び分けは`label`と1対1に保つ。
  it("レビューの段だけ、主語を落とした短縮版を持つ", () => {
    for (const [aiReview, label, shortLabel] of [
      ["pending", "Claudeがレビュー中", "レビュー中"],
      ["passed", "Claudeのレビュー完了", "レビュー完了"],
      ["skipped", "Claudeのレビュー省略", "レビュー省略"],
      ["failed", "Claudeのレビュー失敗", "レビュー失敗"],
    ] as const) {
      const step = labelOf(
        "ai-review",
        buildIssuePullRequestProgress(pullRequest({ mergeJudgement: judgement({ aiReview }) })),
      );
      expect(step?.label).toBe(label);
      expect(step?.shortLabel).toBe(shortLabel);
    }
  });

  it("短縮する必要が無い段は label と同じ文字列を持つ", () => {
    const progress = buildIssuePullRequestProgress(pullRequest({ ciState: "unknown" }));
    for (const step of progress.steps) {
      if (step.key === "ai-review") continue;
      expect(step.shortLabel).toBe(step.label);
    }
  });
});

describe("resolveIssuePullRequestProgress", () => {
  it("開いているPRが無ければ内訳を出さない", () => {
    expect(resolveIssuePullRequestProgress([])).toBeNull();
    expect(
      resolveIssuePullRequestProgress([pullRequest({ state: "closed", merged: true })]),
    ).toBeNull();
  });

  it("開いているPRの内訳を返す", () => {
    const progress = resolveIssuePullRequestProgress([
      pullRequest({ number: 11, state: "closed", merged: true }),
      pullRequest({ number: 12, ciState: "pending", mergeJudgement: judgement({ state: "unknown", aiReview: "none" }) }),
    ]);
    expect(progress).toMatchObject({ pullRequestNumber: 12, label: "CI実行中" });
  });
});

describe("resolvePullRequestPosition（#2867）", () => {
  it("マージの段が来ていれば「マージ待ち」、それまでは「CI・レビュー」", () => {
    // CI成功・レビュー済み・判定済み → マージだけが残っている
    expect(resolvePullRequestPosition(buildIssuePullRequestProgress(pullRequest()))).toBe("merge");
    expect(
      resolvePullRequestPosition(buildIssuePullRequestProgress(pullRequest({ merged: true }))),
    ).toBe("merge");
    expect(
      resolvePullRequestPosition(
        buildIssuePullRequestProgress(pullRequest({ ciState: "pending" })),
      ),
    ).toBe("checks");
    expect(
      resolvePullRequestPosition(
        buildIssuePullRequestProgress(
          pullRequest({ mergeJudgement: judgement({ state: "pending", aiReview: "pending" }) }),
        ),
      ),
    ).toBe("checks");
  });

  it("レビューのcheck-runが後から現れても、判定が動いている間は「CI・レビュー」のまま（分母で割らない）", () => {
    const before = buildIssuePullRequestProgress(
      pullRequest({ mergeJudgement: judgement({ state: "pending", aiReview: "none" }) }),
    );
    const after = buildIssuePullRequestProgress(
      pullRequest({ mergeJudgement: judgement({ state: "pending", aiReview: "pending" }) }),
    );
    expect(before.steps).toHaveLength(3);
    expect(after.steps).toHaveLength(4);
    expect(resolvePullRequestPosition(before)).toBe("checks");
    expect(resolvePullRequestPosition(after)).toBe("checks");
  });

  it("内訳が無ければ最初のマス", () => {
    expect(resolvePullRequestPosition(null)).toBe("checks");
  });
});
