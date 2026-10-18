import { describe, expect, it } from "vitest";

import {
  decideReviewReevaluation,
  describeReviewEvidenceStage,
  describeReviewStageLabel,
  reviewDependsOnEvidence,
  type ReviewReevaluationInput,
  type ReviewStageInput,
} from "./release-review-reevaluation";

const t = (hhmm: string) => new Date(`2026-10-16T${hhmm}:00+09:00`);

/** #4663（RC-3）の再現: 5:1x開始のレビューが5:24に「検証ランナーはrunning」の未確認で終わり、統合検証は5:25に合格 */
function input(overrides: Partial<{
  review: Partial<ReviewReevaluationInput["review"]>;
  integration: ReviewReevaluationInput["integration"];
  lastReviewJob: ReviewReevaluationInput["lastReviewJob"];
}> = {}): ReviewReevaluationInput {
  return {
    review: {
      state: "passed",
      hasDiagnostic: false,
      dependsOnEvidence: true,
      marker: null,
      updatedAt: t("05:24"),
      ...overrides.review,
    },
    integration: "integration" in overrides ? overrides.integration! : { state: "passed", updatedAt: t("05:25") },
    lastReviewJob:
      "lastReviewJob" in overrides
        ? overrides.lastReviewJob!
        : { status: "SUCCEEDED", createdAt: t("05:10"), startedAt: t("05:11"), finishedAt: t("05:24") },
  };
}

describe("reviewDependsOnEvidence", () => {
  it("未確認の確認項目があれば依存とみなす（ランナーの判定と同じ）", () => {
    expect(reviewDependsOnEvidence({ checks: [{ status: "unconfirmed" }], unverifiedScope: null })).toBe(true);
  });
  it("未確認範囲が実行結果の証跡を指すときだけ依存とみなす", () => {
    expect(reviewDependsOnEvidence({ checks: [], unverifiedScope: "検証ランナーのテスト・型検査・ビルドはrunning" })).toBe(true);
    expect(reviewDependsOnEvidence({ checks: [], unverifiedScope: "差分71ファイルのうち65ファイルを確認済み（未確認6）" })).toBe(false);
  });
  it("証跡を指さない未確認（運用作業・観点の読み残し）は依存に数えない（#4767）", () => {
    expect(
      reviewDependsOnEvidence({
        checks: [{ status: "unconfirmed", evidence: "サブPCのpollerを更新・再起動する必要があります" }],
        unverifiedScope: null,
      }),
    ).toBe(false);
    expect(
      reviewDependsOnEvidence({ checks: [{ status: "unconfirmed", evidence: "テスト結果待ち" }], unverifiedScope: null }),
    ).toBe(true);
    // 根拠の無い未確認は何に依存するか分からないので、依存側へ倒す
    expect(reviewDependsOnEvidence({ checks: [{ status: "unconfirmed", evidence: "" }], unverifiedScope: null })).toBe(true);
  });
});

describe("decideReviewReevaluation", () => {
  it("通常経路（#4763）: 統合検証の完了後に開始したレビューは、未確認が残っても再評価しない", () => {
    const decision = decideReviewReevaluation(
      input({
        review: { updatedAt: t("05:40") },
        integration: { state: "passed", updatedAt: t("05:25") },
        lastReviewJob: { status: "SUCCEEDED", createdAt: t("05:25"), startedAt: t("05:26"), finishedAt: t("05:40") },
      }),
    );
    expect(decision).toEqual({ action: "none", reason: "used_latest_evidence" });
  });

  it("レビュー先行: 統合検証の完了報告で、古い証跡のレビューを再評価する（#4663 5:24→5:25）", () => {
    expect(decideReviewReevaluation(input())).toEqual({ action: "rerun", integrationAt: t("05:25").toISOString() });
  });

  it("統合検証先行: 検証完了より前に始まったレビューが後から終わっても再評価する", () => {
    const decision = decideReviewReevaluation(
      input({
        review: { updatedAt: t("05:30") },
        lastReviewJob: { status: "SUCCEEDED", createdAt: t("05:20"), startedAt: t("05:21"), finishedAt: t("05:30") },
      }),
    );
    expect(decision.action).toBe("rerun");
  });

  it("バンプ後の対象（674140c）でも同じ: 5:38のレビュー→5:39の統合検証で再評価する", () => {
    const decision = decideReviewReevaluation(
      input({
        review: { state: "needs_check", updatedAt: t("05:38") },
        integration: { state: "passed", updatedAt: t("05:39") },
        lastReviewJob: { status: "SUCCEEDED", createdAt: t("05:30"), startedAt: t("05:31"), finishedAt: t("05:38") },
      }),
    );
    expect(decision.action).toBe("rerun");
  });

  it("重大指摘と証跡待ちが混在していても再評価する（指摘ありのfailedも対象）", () => {
    expect(decideReviewReevaluation(input({ review: { state: "failed" } })).action).toBe("rerun");
    expect(decideReviewReevaluation(input({ review: { state: "needs_check" } })).action).toBe("rerun");
  });

  it("統合検証の失敗・要確認も、その結果をレビューに評価させるため再評価する（合格へ読み替えない）", () => {
    expect(decideReviewReevaluation(input({ integration: { state: "failed", updatedAt: t("05:25") } })).action).toBe("rerun");
    expect(decideReviewReevaluation(input({ integration: { state: "needs_check", updatedAt: t("05:25") } })).action).toBe(
      "rerun",
    );
  });

  it("統合検証が結果待ち・対象外・未依頼なら積まない", () => {
    expect(decideReviewReevaluation(input({ integration: { state: "running", updatedAt: t("05:20") } }))).toMatchObject({
      action: "none",
      reason: "integration_pending",
    });
    expect(decideReviewReevaluation(input({ integration: null }))).toMatchObject({ reason: "integration_pending" });
    expect(decideReviewReevaluation(input({ integration: { state: "not_applicable", updatedAt: t("05:25") } }))).toMatchObject({
      reason: "integration_unusable",
    });
  });

  it("重複報告・同時完了: 同じ統合検証の完了では1回しか積まない", () => {
    const marker = { integrationAt: t("05:25").toISOString(), requestedAt: t("05:25").toISOString() };
    expect(decideReviewReevaluation(input({ review: { marker } }))).toMatchObject({ reason: "already_reevaluated" });
  });

  it("再評価の結果に指摘が残っても、同じ証跡では繰り返さない（新しいジョブは最新の証跡を読んでいる）", () => {
    const decision = decideReviewReevaluation(
      input({
        review: { state: "needs_check", updatedAt: t("05:28") },
        lastReviewJob: { status: "SUCCEEDED", createdAt: t("05:25"), startedAt: t("05:26"), finishedAt: t("05:28") },
      }),
    );
    expect(decision).toMatchObject({ action: "none", reason: "used_latest_evidence" });
  });

  it("新しい統合検証の完了が届いたときだけ、もう一度再評価する", () => {
    const marker = { integrationAt: t("05:25").toISOString(), requestedAt: t("05:25").toISOString() };
    const decision = decideReviewReevaluation(
      input({
        review: { marker, updatedAt: t("05:28") },
        integration: { state: "passed", updatedAt: t("06:10") },
        lastReviewJob: { status: "SUCCEEDED", createdAt: t("05:25"), startedAt: t("05:26"), finishedAt: t("05:28") },
      }),
    );
    expect(decision.action).toBe("rerun");
  });

  it("実行中・待機中のジョブがあれば積まない（手動再実行・巡回との競合）", () => {
    for (const status of ["QUEUED", "CLAIMED", "RUNNING"]) {
      expect(
        decideReviewReevaluation(input({ lastReviewJob: { status, createdAt: t("05:25"), startedAt: null } })),
      ).toMatchObject({ reason: "review_active" });
    }
  });

  it("実行失敗（診断あり）・証跡に依存しない結果は積まない", () => {
    expect(decideReviewReevaluation(input({ review: { state: "failed", hasDiagnostic: true } }))).toMatchObject({
      reason: "execution_failed",
    });
    expect(decideReviewReevaluation(input({ review: { dependsOnEvidence: false } }))).toMatchObject({
      reason: "no_evidence_dependency",
    });
  });

  it("自動で積んだ再評価が報告なしで終わったら、確認中のまま残さず失敗へ戻す（通知欠落）", () => {
    const marker = { integrationAt: t("05:25").toISOString(), requestedAt: t("05:25").toISOString() };
    const decision = decideReviewReevaluation(
      input({
        review: { state: "waiting", marker },
        lastReviewJob: { status: "TIMEOUT", createdAt: t("05:25"), startedAt: null, finishedAt: t("05:40") },
      }),
    );
    expect(decision.action).toBe("fail_stalled");
  });

  it("通常のレビュー実行中（印なし）は何もしない", () => {
    expect(
      decideReviewReevaluation(
        input({ review: { state: "waiting" }, lastReviewJob: { status: "TIMEOUT", createdAt: t("05:25") } }),
      ),
    ).toMatchObject({ reason: "review_in_progress" });
  });
});

function review(overrides: Partial<ReviewStageInput> = {}): ReviewStageInput {
  return {
    state: "needs_check",
    updatedAt: t("05:24").toISOString(),
    findingsCount: 0,
    checks: [{ status: "confirmed" }, { status: "unconfirmed", evidence: "検証ランナーのテスト・型検査・ビルドはrunning" }],
    openFiles: 0,
    unverifiedScope: "確認項目1件が未確認です（テスト）",
    reason: null,
    summary: null,
    autoReevaluation: null,
    executionFailed: false,
    ...overrides,
  };
}

describe("describeReviewEvidenceStage", () => {
  it("統合検証の完了まで開始を待たせている間は「統合検証の完了待ち」（#4763）", () => {
    const awaiting = review({ state: "waiting", checks: null, unverifiedScope: null, awaitingIntegration: true });
    const stage = describeReviewEvidenceStage(awaiting, { state: "running", updatedAt: null });
    expect(stage).toEqual({ kind: "awaiting_integration" });
    expect(describeReviewStageLabel(stage)).toBe("統合検証の完了待ち");
    // 統合検証が終わった後は、開始されるまで「全体レビュー中」（完了待ちとは出さない）
    expect(describeReviewEvidenceStage(awaiting, { state: "passed", updatedAt: t("05:25").toISOString() }).kind).toBe(
      "reviewing",
    );
    // 印の無い待機中は従来どおり
    expect(
      describeReviewEvidenceStage(review({ state: "waiting", checks: null, unverifiedScope: null }), {
        state: "running",
        updatedAt: null,
      }).kind,
    ).toBe("reviewing");
  });

  it("コード確認が先に終わったら「コード確認済み・統合検証待ち」（最終確認は未完了）", () => {
    const stage = describeReviewEvidenceStage(review(), { state: "running", updatedAt: t("05:20").toISOString() });
    expect(stage).toEqual({ kind: "integration_waiting" });
    expect(describeReviewStageLabel(stage)).toBe("コード確認済み・統合検証待ち");
  });

  it("統合検証が完了し、再評価がまだ積まれていない間も「検証結果を確認中」（統合検証中とは出さない）", () => {
    const stage = describeReviewEvidenceStage(review(), { state: "passed", updatedAt: t("05:25").toISOString() });
    expect(stage.kind).toBe("reevaluating");
  });

  it("自動再評価の実行中は「検証結果を確認中」", () => {
    const marker = { integrationAt: t("05:25").toISOString(), requestedAt: t("05:25").toISOString() };
    const stage = describeReviewEvidenceStage(review({ state: "running", autoReevaluation: marker }), {
      state: "passed",
      updatedAt: t("05:25").toISOString(),
    });
    expect(stage.kind).toBe("reevaluating");
  });

  it("再評価で全部確認できたら完了", () => {
    const stage = describeReviewEvidenceStage(
      review({ state: "passed", checks: [{ status: "confirmed" }], unverifiedScope: null, updatedAt: t("05:28").toISOString() }),
      { state: "passed", updatedAt: t("05:25").toISOString() },
    );
    expect(stage.kind).toBe("complete");
  });

  it("再評価後も残る項目は「自動再評価済み・対応／判断が必要」と内訳を区別して出す", () => {
    const marker = { integrationAt: t("05:25").toISOString(), requestedAt: t("05:25").toISOString() };
    const stage = describeReviewEvidenceStage(
      review({
        findingsCount: 1,
        updatedAt: t("05:28").toISOString(),
        autoReevaluation: marker,
        checks: [{ status: "unconfirmed", evidence: "サブPCのpollerを更新・再起動する必要があります" }],
        openFiles: 2,
      }),
      { state: "passed", updatedAt: t("05:25").toISOString() },
    );
    expect(stage).toEqual({
      kind: "needs_check",
      autoReevaluated: true,
      items: ["findings", "ops", "review_unconfirmed", "code_unread"],
    });
    expect(describeReviewStageLabel(stage)).toBe("自動再評価済み・対応／判断が必要");
  });

  it("証跡に依存しない未確認は、統合検証を待たせず別の内訳として出す（#4767）", () => {
    const stage = describeReviewEvidenceStage(
      review({ checks: [{ status: "unconfirmed", evidence: "移行手順の記載を読み切れませんでした" }], unverifiedScope: null }),
      { state: "running", updatedAt: null },
    );
    expect(stage).toEqual({ kind: "needs_check", autoReevaluated: false, items: ["check_unconfirmed"] });
  });

  it("統合検証の失敗はその結果の確認として出し、合格にしない", () => {
    const marker = { integrationAt: t("05:25").toISOString(), requestedAt: t("05:25").toISOString() };
    const stage = describeReviewEvidenceStage(review({ updatedAt: t("05:28").toISOString(), autoReevaluation: marker }), {
      state: "failed",
      updatedAt: t("05:25").toISOString(),
    });
    expect(stage).toMatchObject({ kind: "needs_check", items: ["evidence_failed"] });
  });

  it("指摘が別にあるときは、統合検証待ちでも要確認を優先する（待てば進むとは見せない）", () => {
    const stage = describeReviewEvidenceStage(review({ findingsCount: 2 }), { state: "running", updatedAt: null });
    expect(stage).toMatchObject({ kind: "needs_check", items: ["findings", "evidence_waiting"] });
  });

  it("実行失敗は失敗、未実施は段階なし", () => {
    expect(
      describeReviewEvidenceStage(review({ state: "failed", executionFailed: true }), { state: "passed", updatedAt: null }).kind,
    ).toBe("failed");
    expect(describeReviewEvidenceStage(review({ state: "not_run" }), { state: "passed", updatedAt: null }).kind).toBe("none");
  });
});
