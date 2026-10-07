import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AI_REVIEW_NONE,
  dropSupersededCheckRuns,
  fetchCheckRollup,
  fetchPullRequestRollup,
  fetchPullRequestRollups,
  pullRequestRollupKey,
} from "@/lib/github/check-rollup";

function stubGraphql(body: unknown, status = 200) {
  const calls: { url: string; body: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ?? "" });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function rollupResponse(rollup: unknown) {
  return { data: { repository: { object: { statusCheckRollup: rollup } } } };
}

/**
 * GitHub Actions発のcheck-runノード。`workflowFile`はcallerのファイル名（#1799）。
 * `job`はcheck-run名の「callerのジョブID / ジョブ名」のうち後半（#2059）。
 */
function checkRun(
  status: string,
  conclusion: string | null,
  workflowFile: string,
  job = "job",
) {
  return {
    __typename: "CheckRun",
    name: `review / ${job}`,
    detailsUrl: `https://github.com/owner/repo/actions/runs/1/job/${job}`,
    status,
    conclusion,
    checkSuite: {
      workflowRun: {
        workflow: { resourcePath: `/owner/repo/actions/workflows/${workflowFile}` },
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchCheckRollup", () => {
  it("refを`expression`として渡し、GraphQLへ1回だけ問い合わせる", async () => {
    const calls = stubGraphql(
      rollupResponse({ state: "SUCCESS", contexts: { totalCount: 0, nodes: [] } }),
    );

    await fetchCheckRollup("owner", "repo", "5dd3448", "token");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(JSON.parse(calls[0]?.body ?? "{}").variables).toEqual({
      owner: "owner",
      name: "repo",
      expression: "5dd3448",
    });
  });

  it("GraphQLの大文字の列挙をcheck-runと同じ小文字へ正規化する", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 2,
          nodes: [
            { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
            { __typename: "CheckRun", status: "COMPLETED", conclusion: "CANCELLED" },
          ],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "pending",
      checks: [
        { status: "in_progress", conclusion: null },
        { status: "completed", conclusion: "cancelled" },
      ],
      mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
      ciRunId: null,
      ciChecks: expect.any(Array),
    });
  });

  it("共通チェック（issue-deck/ci-gate）があれば、止まったActionsが残っていてもそれだけで合否を決め、Actionsの内訳は残す（#4065）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 2,
          nodes: [
            checkRun("QUEUED", null, "ci.yml", "lint-and-build"),
            { __typename: "StatusContext", context: "issue-deck/ci-gate", state: "SUCCESS" },
          ],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.checks).toEqual([{ status: "completed", conclusion: "success" }]);
    expect(rollup?.ciChecks).toHaveLength(1);
    expect(rollup?.ciChecks[0]).toMatchObject({ name: "lint-and-build", status: "queued" });
  });

  it("共通チェックが失敗なら、Actionsが成功していても失敗（都合のよい成功だけを採用しない）", async () => {
    stubGraphql(
      rollupResponse({
        state: "FAILURE",
        contexts: {
          totalCount: 2,
          nodes: [
            checkRun("COMPLETED", "SUCCESS", "ci.yml", "lint-and-build"),
            { __typename: "StatusContext", context: "issue-deck/ci-gate", state: "FAILURE" },
          ],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.checks).toEqual([{ status: "completed", conclusion: "failure" }]);
  });

  it("commit status（StatusContext）はcheck-runの形へ寄せる", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 3,
          nodes: [
            { __typename: "StatusContext", state: "SUCCESS" },
            { __typename: "StatusContext", state: "ERROR" },
            { __typename: "StatusContext", state: "PENDING" },
          ],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "pending",
      checks: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
        { status: "pending", conclusion: null },
      ],
      mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
      ciRunId: null,
      ciChecks: expect.any(Array),
    });
  });

  it("運用自動化（レビュー・自動マージ等）のcheck-runは集約から外す（#1799）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 3,
          nodes: [
            checkRun("COMPLETED", "SUCCESS", "ci.yml"),
            // CIの完了を待って動くジョブ。数えるとPRが開いている間ずっと「CI実行中」になる。
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml"),
            checkRun("QUEUED", null, "issue-labels.yml"),
          ],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "pending",
      checks: [{ status: "completed", conclusion: "success" }],
      ciRunId: 1,
      ciChecks: expect.any(Array),
      mergeJudgement: {
        state: "pending",
        step: null,
        runUrl: "https://github.com/owner/repo/actions/runs/1/job/job",
        aiReview: AI_REVIEW_NONE,
      },
    });
  });

  it("CIの内訳を開くrunは「失敗 → 実行中 → 先頭」の順で選ぶ（#2777）", async () => {
    stubGraphql(
      rollupResponse({
        state: "FAILURE",
        contexts: {
          totalCount: 3,
          nodes: [
            {
              ...checkRun("COMPLETED", "SUCCESS", "ci.yml", "docs"),
              detailsUrl: "https://github.com/owner/repo/actions/runs/11/job/1",
            },
            {
              ...checkRun("IN_PROGRESS", null, "ci.yml", "build"),
              detailsUrl: "https://github.com/owner/repo/actions/runs/22/job/2",
            },
            {
              ...checkRun("COMPLETED", "FAILURE", "ci.yml", "test"),
              detailsUrl: "https://github.com/owner/repo/actions/runs/33/job/3",
            },
          ],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.ciRunId).toBe(33);
  });

  it("実行ログのURLが読めなければ内訳を出さない（#2777）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 1,
          nodes: [{ ...checkRun("IN_PROGRESS", null, "ci.yml"), detailsUrl: null }],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.ciRunId).toBeNull();
  });

  it("内訳の行は、CI状態と同じ母集団（運用自動化を除いた全チェック）になる（#2777）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 3,
          nodes: [
            checkRun("COMPLETED", "SUCCESS", "ci.yml", "lint-and-build"),
            // mainへのリリースPRでは`ci.yml`以外の検査系もCI状態に入る
            checkRun("IN_PROGRESS", null, "version-tag-check.yml", "version-tag-check"),
            // 運用自動化はCI状態から外れるので、内訳にも出さない
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml", "claude-review"),
          ],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.ciChecks.map((check) => check.name)).toEqual([
      "lint-and-build",
      "version-tag-check",
    ]);
  });

  it("外部CI（commit status）が混ざるときは内訳を出さない（#2777）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 2,
          nodes: [
            checkRun("COMPLETED", "SUCCESS", "ci.yml", "lint-and-build"),
            { __typename: "StatusContext", state: "FAILURE" },
          ],
        },
      }),
    );

    // 行にできないチェックがある状態で並べると、バッジは失敗なのに内訳は全部成功に見える
    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.ciChecks).toEqual([]);
  });

  it("チェックが100件を超えるときは内訳を出さない（1件ずつ見ていないため）（#2777）", async () => {
    stubGraphql(
      rollupResponse({
        state: "SUCCESS",
        contexts: {
          totalCount: 218,
          nodes: [checkRun("COMPLETED", "SUCCESS", "ci.yml", "lint-and-build")],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.ciChecks).toEqual([]);
  });

  it("ワークフローが分からないチェック（外部CI・他のアプリ）は数える", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 3,
          nodes: [
            checkRun("COMPLETED", "SUCCESS", "ci.yml"),
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml"),
            { __typename: "StatusContext", state: "PENDING" },
          ],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "pending",
      checks: [
        { status: "completed", conclusion: "success" },
        { status: "pending", conclusion: null },
      ],
      ciRunId: 1,
      ciChecks: expect.any(Array),
      mergeJudgement: {
        state: "pending",
        step: null,
        runUrl: "https://github.com/owner/repo/actions/runs/1/job/job",
        aiReview: AI_REVIEW_NONE,
      },
    });
  });

  it("運用自動化しか無いリポジトリでは、除く前のチェックをそのまま返す", async () => {
    stubGraphql(
      rollupResponse({
        state: "SUCCESS",
        contexts: {
          totalCount: 2,
          nodes: [
            checkRun("COMPLETED", "SUCCESS", "issue-labels.yml"),
            checkRun("COMPLETED", "SKIPPED", "claude-review-develop.yml"),
          ],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "success",
      checks: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
      ],
      mergeJudgement: { state: "settled", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
      ciRunId: 1,
      ciChecks: expect.any(Array),
    });
  });

  it("自動マージ可否の判定が実行中なら`mergeJudgement`は`pending`（CIは通っていても）（#1968）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 2,
          nodes: [
            // PR #1959の再現。CIは通っているが、判定はまだ走っている。
            checkRun("COMPLETED", "SUCCESS", "ci.yml"),
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml"),
          ],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    // CI状態は`success`のままで、判定の進み具合だけが別の軸として`pending`になる。
    expect(rollup?.checks).toEqual([{ status: "completed", conclusion: "success" }]);
    expect(rollup?.mergeJudgement.state).toBe("pending");
  });

  /**
   * Claudeのレビューが終わったか（#2150）。判定全体（`mergeJudgement.state`）とは別の軸で、
   * `claude-review`ジョブのcheck-runだけを見る。
   */
  describe("aiReview", () => {
    async function aiReviewOf(nodes: unknown[]) {
      stubGraphql(
        rollupResponse({ state: "SUCCESS", contexts: { totalCount: nodes.length, nodes } }),
      );
      const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
      return rollup?.mergeJudgement.aiReview;
    }

    it("レビューが成功していれば`passed`。実行ログのURLも返す", async () => {
      expect(
        await aiReviewOf([
          checkRun("COMPLETED", "SUCCESS", "ci.yml"),
          checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "claude-review"),
          checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "auto-merge"),
        ]),
      ).toEqual({
        state: "passed",
        runUrl: "https://github.com/owner/repo/actions/runs/1/job/claude-review",
      });
    });

    // 差分が小さいPRでは`risk-check`がレビューを飛ばす（#992）。GitHubは`if`で飛ばした
    // ジョブも`skipped`のcheck-runとして出すため、「走らなかった」と言い切れる。
    it("差分が小さくレビューが実行されなかった場合は`skipped`", async () => {
      expect(
        (
          await aiReviewOf([
            checkRun("COMPLETED", "SKIPPED", "claude-review-develop.yml", "claude-review"),
          ])
        )?.state,
      ).toBe("skipped");
    });

    it("レビュー自体が落ちた場合は`failed`", async () => {
      expect(
        (
          await aiReviewOf([
            checkRun("COMPLETED", "FAILURE", "claude-review-develop.yml", "claude-review"),
            // 肩代わりジョブは`00.check-user`を付けるだけで、レビューをやり直すわけではない
            checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "claude-review-fallback"),
          ])
        )?.state,
      ).toBe("failed");
    });

    it("レビューが実行中なら`pending`", async () => {
      expect(
        (
          await aiReviewOf([
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml", "claude-review"),
          ])
        )?.state,
      ).toBe("pending");
    });

    // ワークフローは配られているが、レビューのジョブがまだ現れていない場合。
    it("レビューのcheck-runが1件も無ければ`none`", async () => {
      expect(
        await aiReviewOf([
          checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "risk-check"),
        ]),
      ).toEqual(AI_REVIEW_NONE);
    });

    // 肩代わりジョブは名前が似ているだけで役割が違う。これだけでは「レビューが終わった」と言わない。
    it("肩代わりジョブ（claude-review-fallback）だけでは`none`", async () => {
      expect(
        await aiReviewOf([
          checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "claude-review-fallback"),
        ]),
      ).toEqual(AI_REVIEW_NONE);
    });

    it("チェックが多すぎて1件ずつ見られない場合は`none`", async () => {
      stubGraphql(
        rollupResponse({
          state: "SUCCESS",
          contexts: {
            totalCount: 101,
            nodes: [checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "claude-review")],
          },
        }),
      );
      const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
      expect(rollup?.mergeJudgement.aiReview).toEqual(AI_REVIEW_NONE);
    });
  });

  it("判定のワークフローが配られていないリポジトリでは`unknown`（#1968）", async () => {
    stubGraphql(
      rollupResponse({
        state: "SUCCESS",
        contexts: {
          totalCount: 1,
          nodes: [checkRun("COMPLETED", "SUCCESS", "ci.yml")],
        },
      }),
    );

    await expect(
      fetchCheckRollup("owner", "repo", "develop", "token").then((r) => r?.mergeJudgement.state),
    ).resolves.toBe("unknown");
  });

  it("判定中は実行中のジョブを`step`・実行ログを`runUrl`として返す（#2059）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 4,
          nodes: [
            checkRun("COMPLETED", "SUCCESS", "ci.yml", "lint-and-build"),
            checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "wait-for-ci"),
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml", "claude-review"),
            // `needs`待ちの後続ジョブもcheck-runとしては先に並ぶ。実行中の方を名乗らせる。
            checkRun("QUEUED", null, "claude-review-develop.yml", "auto-merge"),
          ],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.mergeJudgement).toEqual({
      state: "pending",
      step: "claude-review",
      runUrl: "https://github.com/owner/repo/actions/runs/1/job/claude-review",
      aiReview: {
        state: "pending",
        runUrl: "https://github.com/owner/repo/actions/runs/1/job/claude-review",
      },
    });
  });

  it("CI完了待ちとレビューが同時に走っている間はレビューを名乗る（#2066）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 4,
          nodes: [
            checkRun("IN_PROGRESS", null, "ci.yml", "lint-and-build"),
            // wait-for-ciはrisk-check・claude-reviewと並行して走る（#2066）。CIの進み具合は
            // 隣のCI状態のピルが出しているので、判定側で動いているものを優先して名乗らせる。
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml", "wait-for-ci"),
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml", "claude-review"),
            checkRun("QUEUED", null, "claude-review-develop.yml", "auto-merge"),
          ],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.mergeJudgement.step).toBe("claude-review");
  });

  it("レビューが終わってCI完了待ちだけが残れば「CIの完了待ち」を名乗る（#2066）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 3,
          nodes: [
            checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "claude-review"),
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml", "wait-for-ci"),
            checkRun("QUEUED", null, "claude-review-develop.yml", "auto-merge"),
          ],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.mergeJudgement.step).toBe("wait-for-ci");
  });

  it("実行中が無ければ、進行順がいちばん早い未完了のジョブを待っているものとする（#2059）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 2,
          nodes: [
            checkRun("QUEUED", null, "claude-review-develop.yml", "auto-merge"),
            checkRun("QUEUED", null, "claude-review-develop.yml", "risk-check"),
          ],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.mergeJudgement.step).toBe("risk-check");
  });

  it("肩代わりジョブ（`*-fallback`）は本体と同じ段階として扱う（#2059）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 1,
          nodes: [
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml", "claude-review-fallback"),
          ],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.mergeJudgement.step).toBe("claude-review");
  });

  it("想定外のジョブ名では`step`をnullにする（画面は「マージ可否を判定中」へ縮退。#2059）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 1,
          nodes: [
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml", "identify-issue"),
          ],
        },
      }),
    );

    const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
    expect(rollup?.mergeJudgement.step).toBeNull();
    expect(rollup?.mergeJudgement.runUrl).toBe(
      "https://github.com/owner/repo/actions/runs/1/job/identify-issue",
    );
  });

  /**
   * GitHubから矛盾した状態が返ったcheck-run（#4049）。kurashio#712の`review / review-provider`は
   * `status: IN_PROGRESS`・`conclusion: SUCCESS`・`completedAt`ありのまま残り、ワークフローも
   * 全ジョブも終わっているのに「マージ可否を判定中」が消えなかった。
   */
  describe("矛盾した状態のcheck-run（#4049）", () => {
    function withEvidence(
      node: ReturnType<typeof checkRun>,
      evidence: { completedAt?: string | null; suiteStatus?: string | null },
    ) {
      return {
        ...node,
        completedAt: evidence.completedAt ?? null,
        checkSuite: { ...node.checkSuite, status: evidence.suiteStatus ?? null },
      };
    }

    async function judgementOf(nodes: unknown[]) {
      stubGraphql(rollupResponse({ state: "SUCCESS", contexts: { totalCount: nodes.length, nodes } }));
      const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
      return rollup?.mergeJudgement;
    }

    const KURASHIO_712 = [
      checkRun("COMPLETED", "SUCCESS", "ci.yml", "lint-and-build"),
      checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "identify-issue"),
      checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "risk-check"),
      withEvidence(checkRun("IN_PROGRESS", "SUCCESS", "claude-review-develop.yml", "review-provider"), {
        completedAt: "2026-10-05T12:05:50Z",
        suiteStatus: "COMPLETED",
      }),
      checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "claude-review"),
      checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "auto-merge"),
    ];

    it("実データ相当（in_progress＋success＋completedAt、suite完了）は判定済みにする", async () => {
      const judgement = await judgementOf(KURASHIO_712);
      expect(judgement?.state).toBe("settled");
      // レビューの結果（LGTMかどうか）には触れない。終わったことだけを返す。
      expect(judgement?.aiReview.state).toBe("passed");
    });

    it("conclusionとcompletedAtが揃っていれば、suiteの状態が取れなくても判定済みにする", async () => {
      const judgement = await judgementOf([
        withEvidence(checkRun("IN_PROGRESS", "SUCCESS", "claude-review-develop.yml", "review-provider"), {
          completedAt: "2026-10-05T12:05:50Z",
        }),
        checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "auto-merge"),
      ]);
      expect(judgement?.state).toBe("settled");
    });

    it("失敗・キャンセルで終わった矛盾値も判定済みにする（結論は書き換えない）", async () => {
      const judgement = await judgementOf([
        withEvidence(checkRun("IN_PROGRESS", "CANCELLED", "claude-review-develop.yml", "claude-review"), {
          completedAt: "2026-10-05T12:05:50Z",
        }),
        checkRun("COMPLETED", "SUCCESS", "claude-review-develop.yml", "auto-merge-fallback"),
      ]);
      expect(judgement?.state).toBe("settled");
      expect(judgement?.aiReview.state).toBe("failed");
    });

    it("本当に実行中の必須チェックがあれば、矛盾値が終わっていても判定中を維持する", async () => {
      const judgement = await judgementOf([
        withEvidence(checkRun("IN_PROGRESS", "SUCCESS", "claude-review-develop.yml", "review-provider"), {
          completedAt: "2026-10-05T12:05:50Z",
        }),
        checkRun("IN_PROGRESS", null, "claude-review-develop.yml", "claude-review"),
        checkRun("QUEUED", null, "claude-review-develop.yml", "auto-merge"),
      ]);
      expect(judgement?.state).toBe("pending");
      expect(judgement?.step).toBe("claude-review");
    });

    it("再実行で同名のcheck-runが並んでも、旧attemptの終了で今の実行中は解除しない", async () => {
      const judgement = await judgementOf([
        checkRun("COMPLETED", "FAILURE", "claude-review-develop.yml", "claude-review"),
        checkRun("IN_PROGRESS", null, "claude-review-develop.yml", "claude-review"),
      ]);
      expect(judgement?.state).toBe("pending");
      expect(judgement?.aiReview.state).toBe("pending");
    });

    it("suiteが実行中（再実行で戻った）なら、completedAtの無い矛盾値は終わった扱いにしない", async () => {
      const judgement = await judgementOf([
        withEvidence(checkRun("IN_PROGRESS", "SUCCESS", "claude-review-develop.yml", "auto-merge"), {
          suiteStatus: "IN_PROGRESS",
        }),
      ]);
      expect(judgement?.state).toBe("pending");
      expect(judgement?.step).toBe("state-mismatch");
    });

    it.each([
      ["conclusionだけ", { status: "IN_PROGRESS", conclusion: "SUCCESS", evidence: {} }],
      [
        "completedAtだけ（結論なし）",
        { status: "IN_PROGRESS", conclusion: null, evidence: { completedAt: "2026-10-05T12:05:50Z" } },
      ],
      [
        "suiteの完了だけ（結論なし）",
        { status: "IN_PROGRESS", conclusion: null, evidence: { suiteStatus: "COMPLETED" } },
      ],
    ])("終了の根拠が足りない矛盾値（%s）は判定中のまま、段階を「再確認中」にする", async (_, input) => {
      const judgement = await judgementOf([
        withEvidence(checkRun(input.status, input.conclusion, "claude-review-develop.yml", "auto-merge"), input.evidence),
      ]);
      expect(judgement).toMatchObject({
        state: "pending",
        step: "state-mismatch",
        runUrl: "https://github.com/owner/repo/actions/runs/1/job/auto-merge",
      });
    });

    it("根拠の無いふつうの実行中は、時間がどれだけ経っても判定中のまま", async () => {
      const node = { ...checkRun("IN_PROGRESS", null, "claude-review-develop.yml", "review-provider"), startedAt: "2020-01-01T00:00:00Z" };
      const judgement = await judgementOf([node]);
      expect(judgement?.state).toBe("pending");
      // 補助ジョブも段階を名乗る（「マージ可否を判定中」への縮退ではなく既知の段階として扱う）。
      expect(judgement?.step).toBe("risk-check");
    });

    it("CIの集約・内訳も同じ根拠で完了扱いにする", async () => {
      const node = withEvidence(checkRun("IN_PROGRESS", "SUCCESS", "ci.yml", "lint-and-build"), {
        completedAt: "2026-10-05T12:05:50Z",
      });
      stubGraphql(rollupResponse({ state: "PENDING", contexts: { totalCount: 1, nodes: [node] } }));
      const rollup = await fetchCheckRollup("owner", "repo", "develop", "token");
      expect(rollup?.checks).toEqual([{ status: "completed", conclusion: "success" }]);
      expect(rollup?.ciChecks[0]?.status).toBe("completed");
    });

    it("問い合わせにcheck-suiteの状態とcompletedAtを含める", async () => {
      const calls = stubGraphql(rollupResponse(null));
      await fetchCheckRollup("owner", "repo", "develop", "token");
      const query = JSON.parse(calls[0].body).query as string;
      expect(query).toContain("completedAt");
      expect(query).toMatch(/checkSuite \{\s*status/);
    });
  });

  it("チェックが100件を超える場合は1件ずつ返さず、`state`だけを返す", async () => {
    stubGraphql(
      rollupResponse({
        state: "SUCCESS",
        contexts: {
          totalCount: 218,
          nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "success",
      checks: null,
      mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
      ciRunId: null,
      ciChecks: expect.any(Array),
    });
  });

  it("チェックが1件も無いrefでは空の一覧を返す", async () => {
    stubGraphql(rollupResponse(null));

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: null,
      checks: [],
      mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
      ciRunId: null,
      ciChecks: expect.any(Array),
    });
  });

  it("GraphQLがエラーを返した場合はnullを返す（例外にしない）", async () => {
    stubGraphql({ errors: [{ message: "Resource not accessible by integration" }] });

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toBeNull();
  });

  it("HTTPが失敗した場合もnullを返す", async () => {
    stubGraphql({}, 502);

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toBeNull();
  });
});

/** エイリアス（`p0`・`p1`…）ごとのPRを並べた応答（#1962） */
function pullRequestResponse(...pullRequests: unknown[]) {
  return {
    data: Object.fromEntries(
      pullRequests.map((pullRequest, index) => [`p${index}`, { pullRequest }]),
    ),
  };
}

function pullRequestNode(mergeable: string | null, rollup: unknown) {
  return { mergeable, commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] } };
}

function pullRequestWithRollup(mergeable: string | null, rollup: unknown) {
  return pullRequestResponse(pullRequestNode(mergeable, rollup));
}

describe("fetchPullRequestRollup", () => {
  it("CI状態とコンフリクト有無をGraphQL 1回でまとめて取る（#1742）", async () => {
    const calls = stubGraphql(
      pullRequestWithRollup("CONFLICTING", {
        state: "SUCCESS",
        contexts: {
          totalCount: 1,
          nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      }),
    );

    await expect(fetchPullRequestRollup("owner", "repo", 42, "token")).resolves.toEqual({
      rollup: {
        state: "success",
        checks: [{ status: "completed", conclusion: "success" }],
        mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
        ciRunId: null,
        ciChecks: expect.any(Array),
      },
      mergeable: false,
      iosPrecheck: null,
    });
    // ref経由（`fetchCheckRollup`）と足して2回にならないこと自体がこの関数の目的。
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}").variables).toEqual({
      owner0: "owner",
      name0: "repo",
      number0: 42,
    });
  });

  it("`MERGEABLE`はtrue、`UNKNOWN`（判定中）はnullにする", async () => {
    stubGraphql(pullRequestWithRollup("MERGEABLE", null));
    await expect(fetchPullRequestRollup("owner", "repo", 1, "token")).resolves.toEqual({
      rollup: {
        state: null,
        checks: [],
        mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
        ciRunId: null,
        ciChecks: expect.any(Array),
      },
      mergeable: true,
      iosPrecheck: null,
    });

    stubGraphql(pullRequestWithRollup("UNKNOWN", null));
    await expect(fetchPullRequestRollup("owner", "repo", 1, "token")).resolves.toEqual({
      rollup: {
        state: null,
        checks: [],
        mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
        ciRunId: null,
        ciChecks: expect.any(Array),
      },
      mergeable: null,
      iosPrecheck: null,
    });
  });

  it("コミットが取れない場合もチェック無しとして扱う", async () => {
    stubGraphql(pullRequestResponse({ mergeable: "MERGEABLE", commits: { nodes: [] } }));

    await expect(fetchPullRequestRollup("owner", "repo", 1, "token")).resolves.toEqual({
      rollup: {
        state: null,
        checks: [],
        mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
        ciRunId: null,
        ciChecks: expect.any(Array),
      },
      mergeable: true,
      iosPrecheck: null,
    });
  });

  it("取得に失敗した場合は例外にせず未取得として返す", async () => {
    stubGraphql({ errors: [{ message: "Resource not accessible by integration" }] });

    await expect(fetchPullRequestRollup("owner", "repo", 1, "token")).resolves.toEqual({
      rollup: null,
      mergeable: null,
      iosPrecheck: null,
    });
  });

  it("PRが見つからない場合も未取得として返す", async () => {
    stubGraphql(pullRequestResponse(null));

    await expect(fetchPullRequestRollup("owner", "repo", 1, "token")).resolves.toEqual({
      rollup: null,
      mergeable: null,
      iosPrecheck: null,
    });
  });
});

describe("fetchPullRequestRollups", () => {
  it("複数リポジトリのPRをエイリアスで1クエリにまとめる（#1962）", async () => {
    const calls = stubGraphql(
      pullRequestResponse(
        pullRequestNode("MERGEABLE", { state: "SUCCESS", contexts: { totalCount: 0, nodes: [] } }),
        pullRequestNode("CONFLICTING", { state: "FAILURE", contexts: { totalCount: 0, nodes: [] } }),
      ),
    );

    const rollups = await fetchPullRequestRollups(
      [
        { owner: "owner", repo: "repo", number: 1 },
        { owner: "owner", repo: "other", number: 2 },
      ],
      "token",
    );

    // PR件数ぶんではなく1回で済んでいることがこの関数の目的そのもの。
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}").variables).toEqual({
      owner0: "owner",
      name0: "repo",
      number0: 1,
      owner1: "owner",
      name1: "other",
      number1: 2,
    });
    expect(rollups.get(pullRequestRollupKey("owner", "repo", 1))?.mergeable).toBe(true);
    expect(rollups.get(pullRequestRollupKey("owner", "other", 2))?.mergeable).toBe(false);
  });

  it("25件を超える場合はクエリを分割する", async () => {
    const calls = stubGraphql(
      pullRequestResponse(
        ...Array.from({ length: 25 }, () =>
          pullRequestNode("MERGEABLE", { state: "SUCCESS", contexts: { totalCount: 0, nodes: [] } }),
        ),
      ),
    );

    const rollups = await fetchPullRequestRollups(
      Array.from({ length: 30 }, (_, index) => ({ owner: "owner", repo: "repo", number: index })),
      "token",
    );

    expect(calls).toHaveLength(2);
    // 応答は25件ぶんを使い回しているため、2本目は先頭5件だけが埋まる。
    expect(rollups.size).toBe(30);
  });

  it("一部のPRだけ読めなかった場合、残りは返す（`allowPartialData`）", async () => {
    stubGraphql({
      data: {
        p0: null,
        p1: {
          pullRequest: pullRequestNode("MERGEABLE", {
            state: "SUCCESS",
            contexts: { totalCount: 0, nodes: [] },
          }),
        },
      },
      errors: [{ message: "Could not resolve to a Repository" }],
    });

    const rollups = await fetchPullRequestRollups(
      [
        { owner: "owner", repo: "gone", number: 1 },
        { owner: "owner", repo: "repo", number: 2 },
      ],
      "token",
    );

    // 読めなかったPRはキーごと落とし、呼び出し側で`unknown`へ縮退させる。
    expect(rollups.has(pullRequestRollupKey("owner", "gone", 1))).toBe(false);
    expect(rollups.get(pullRequestRollupKey("owner", "repo", 2))?.rollup).toEqual({
      state: "success",
      checks: [],
      mergeJudgement: { state: "unknown", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
      ciRunId: null,
      ciChecks: expect.any(Array),
    });
  });

  it("クエリ自体が失敗した場合は例外にせず空を返す", async () => {
    stubGraphql({ errors: [{ message: "Bad credentials" }] }, 401);

    await expect(
      fetchPullRequestRollups([{ owner: "owner", repo: "repo", number: 1 }], "token"),
    ).resolves.toEqual(new Map());
  });

  it("対象が無ければGraphQLを1回も投げない", async () => {
    const calls = stubGraphql({});

    await expect(fetchPullRequestRollups([], "token")).resolves.toEqual(new Map());
    expect(calls).toHaveLength(0);
  });
});

/** 時刻付きのcheck-run（#4070）。分は`2026-10-05T16:MM:00Z`の分 */
function timedRun(
  conclusion: string | null,
  startedMinute: number,
  completedMinute: number | null,
  job = "test",
  workflowFile = "ci.yml",
) {
  const at = (minute: number) => `2026-10-05T16:${String(minute).padStart(2, "0")}:00Z`;
  return {
    ...checkRun(completedMinute === null ? "IN_PROGRESS" : "COMPLETED", conclusion, workflowFile, job),
    startedAt: at(startedMinute),
    completedAt: completedMinute === null ? null : at(completedMinute),
  };
}

describe("dropSupersededCheckRuns（#4070）", () => {
  it("失敗した後に同じジョブが再実行されていれば、古い失敗を外す", () => {
    const failed = timedRun("FAILURE", 0, 5);
    const rerun = timedRun("SUCCESS", 10, 15);
    expect(dropSupersededCheckRuns([failed, rerun])).toEqual([rerun]);
  });

  it("キャンセルされた実行は、同時かそれより後に始まった同じジョブがあれば外す", () => {
    const cancelled = timedRun("CANCELLED", 0, 1);
    const running = timedRun(null, 0, null);
    expect(dropSupersededCheckRuns([cancelled, running])).toEqual([running]);
  });

  it("時刻が重なる実行（push・pull_requestの並行実行）はどちらも残す", () => {
    const pushRun = timedRun("FAILURE", 0, 5);
    const prRun = timedRun("SUCCESS", 1, 6);
    expect(dropSupersededCheckRuns([pushRun, prRun])).toEqual([pushRun, prRun]);
  });

  it("同時刻に始まったキャンセルどうしは互いを外し合わない", () => {
    const first = timedRun("CANCELLED", 0, 1);
    const second = timedRun("CANCELLED", 0, 1);
    expect(dropSupersededCheckRuns([first, second])).toEqual([first, second]);
  });

  it("ジョブ名・ワークフローが違えば別物として扱う", () => {
    const lint = timedRun("FAILURE", 0, 5, "lint");
    const test = timedRun("SUCCESS", 10, 15, "test");
    const other = timedRun("SUCCESS", 10, 15, "lint", "other.yml");
    expect(dropSupersededCheckRuns([lint, test, other])).toEqual([lint, test, other]);
  });

  it("時刻が読めないものは外さない", () => {
    const failed = checkRun("COMPLETED", "FAILURE", "ci.yml", "test");
    const rerun = timedRun("SUCCESS", 10, 15);
    expect(dropSupersededCheckRuns([failed, rerun])).toEqual([failed, rerun]);
  });

  it("再実行で通ったCIは、過去の失敗が残っていても「失敗」に数えない", async () => {
    stubGraphql(
      rollupResponse({
        state: "FAILURE",
        contexts: {
          totalCount: 2,
          nodes: [timedRun("FAILURE", 0, 5), timedRun("SUCCESS", 10, 15)],
        },
      }),
    );
    const rollup = await fetchCheckRollup("owner", "repo", "issue-1", "token");
    expect(rollup?.checks).toEqual([{ status: "completed", conclusion: "success" }]);
  });

  it("今の実行が失敗していれば、従来どおり失敗に数える", async () => {
    stubGraphql(
      rollupResponse({
        state: "FAILURE",
        contexts: {
          totalCount: 2,
          nodes: [timedRun("SUCCESS", 0, 5), timedRun("FAILURE", 10, 15)],
        },
      }),
    );
    const rollup = await fetchCheckRollup("owner", "repo", "issue-1", "token");
    expect(rollup?.checks).toEqual([{ status: "completed", conclusion: "failure" }]);
  });
});

describe("iOS事前検証（issue-deck/ios-precheck。#4140）", () => {
  const iosPending = {
    __typename: "StatusContext",
    context: "issue-deck/ios-precheck",
    state: "PENDING",
  };

  it("commit statusはCI状態の集約にも内訳にも数えない", async () => {
    stubGraphql(
      pullRequestWithRollup("MERGEABLE", {
        state: "PENDING",
        contexts: {
          totalCount: 2,
          nodes: [checkRun("COMPLETED", "SUCCESS", "ci.yml", "lint"), iosPending],
        },
      }),
    );

    const { rollup } = await fetchPullRequestRollup("owner", "repo", 1, "token");
    expect(rollup?.checks).toEqual([{ status: "completed", conclusion: "success" }]);
    // StatusContextが混ざると内訳ごと消えていた
    expect(rollup?.ciChecks).toHaveLength(1);
  });

  it("既定（PR一覧）ではコミットの履歴を引かず、iosPrecheckはnull", async () => {
    const calls = stubGraphql(pullRequestWithRollup("MERGEABLE", null));
    await expect(fetchPullRequestRollup("owner", "repo", 1, "token")).resolves.toMatchObject({
      iosPrecheck: null,
    });
    expect(JSON.parse(calls[0]?.body ?? "{}").query).not.toContain("iosPrecheckCommits");
  });

  it("includeIosPrecheckのときは同じ1回のクエリでコミットごとのstatusを引き、要約にする", async () => {
    const calls = stubGraphql(
      pullRequestResponse({
        ...pullRequestNode("MERGEABLE", null),
        iosPrecheckCommits: {
          nodes: [
            {
              commit: {
                oid: "a".repeat(40),
                status: { context: { state: "SUCCESS", description: "ビルド成功", createdAt: null } },
              },
            },
            { commit: { oid: "b".repeat(40), status: null } },
          ],
        },
      }),
    );

    const rollups = await fetchPullRequestRollups([{ owner: "owner", repo: "repo", number: 7 }], "token", {
      includeIosPrecheck: true,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}").query).toContain('context(name: "issue-deck/ios-precheck")');
    expect(rollups.get(pullRequestRollupKey("owner", "repo", 7))?.iosPrecheck).toEqual({
      headSha: "b".repeat(40),
      head: null,
      previous: { phase: "success", description: "ビルド成功", sha: "a".repeat(40), updatedAt: null },
    });
  });
});
