import { findOpsRequest } from "@/lib/release-review-ops-evidence";

/**
 * 統合検証の完了後に、全体レビューの「証跡に依存する未確認」を自動で再評価する判定（#4664）と、
 * 画面に出す共通の段階。**判定はここだけに置き**、サーバー（報告・巡回）と画面（バッジ・説明・詳細）が同じ規則を使う。
 *
 * 再評価そのものは#4632のランナー（`run-release-review.sh`の`invalidate_stale_batches`）が、証跡の指紋が変わった
 * 結果だけを捨てて行う。ここが決めるのは「いつ積むか」だけで、合否は変えない——統合検証の`failed`・`needs_check`は
 * その結果をレビューに評価させ、`passed`へ読み替えない。
 */

/** 記録の`findings.autoReevaluation`。統合検証の完了（`integrationAt`）ごとに1回だけ自動で積んだ印 */
export type ReviewAutoReevaluation = {
  /** 再評価の契機にした統合検証の記録の更新時刻（ISO） */
  integrationAt: string;
  /** 積んだ時刻（ISO） */
  requestedAt: string;
};

export function readAutoReevaluation(findings: unknown): ReviewAutoReevaluation | null {
  const raw =
    typeof findings === "object" && findings !== null && !Array.isArray(findings)
      ? (findings as Record<string, unknown>).autoReevaluation
      : null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.integrationAt !== "string" || typeof r.requestedAt !== "string") return null;
  return { integrationAt: r.integrationAt, requestedAt: r.requestedAt };
}

/**
 * 実行結果（テスト・型検査・ビルド）の証跡を指す未確認の文言。
 * **ランナー（`scripts/run-release-review.sh`の`EVIDENCE_TEXT_PATTERN`）と同じ語を持つ**（変えるときは両方を揃える）
 */
const EVIDENCE_TEXT = /統合検証|検証結果|検証証跡|証跡|実行結果|テスト|型検査|ビルド|running/i;

/**
 * 実行ホスト（サブPCのpoller）の更新・再起動を指す未確認の文言（#4799）。
 * **ランナー（`scripts/run-release-review.sh`の`HOST_TEXT_PATTERN`）と同じ語を持つ**（変えるときは両方を揃える）
 */
const HOST_TEXT = /poller|ポーラー|サブPC|再起動|実機|起動時|実行ホスト|稼働コミット|host_compat/i;

/**
 * レビュー結果が実行ホストの運用状態に左右されているか（#4799）。ランナーの`result_depends_on_host`と同じ規則。
 * 該当する結果は、ホストの事実（起動時コミット・候補を含むか）が変わると、再実行でランナーが保存済みの結果を捨てて見直す。
 * 統合検証の完了では変わらないので、自動再評価（`reviewDependsOnEvidence`）の契機には数えない
 */
export function reviewDependsOnHost(input: {
  checks: readonly { status: string; evidence?: string | null }[] | null | undefined;
  unverifiedScope: string | null | undefined;
}): boolean {
  const hit = (input.checks ?? []).some(
    (c) => c.status === "unconfirmed" && typeof c.evidence === "string" && HOST_TEXT.test(c.evidence),
  );
  return hit || (typeof input.unverifiedScope === "string" && HOST_TEXT.test(input.unverifiedScope));
}

/** 未確認の確認項目が証跡に依存するか。根拠の文言が無いものは、何に依存するか分からないので依存側へ倒す */
export function checkDependsOnEvidence(check: { status: string; evidence?: string | null }): boolean {
  if (check.status !== "unconfirmed") return false;
  const evidence = typeof check.evidence === "string" ? check.evidence.trim() : "";
  return evidence === "" || EVIDENCE_TEXT.test(evidence);
}

/**
 * レビュー結果が統合検証の証跡に左右されているか（#4632・#4767）。ランナーの`result_depends_on_evidence`と同じ規則で、
 * **証跡を指す文言の未確認項目・未確認範囲だけ**を依存に数える。poller更新のような運用の未確認（`reviewDependsOnHost`）やコードの未読は、
 * 統合検証が終わっても変わらないので積まない
 */
export function reviewDependsOnEvidence(input: {
  checks: readonly { status: string; evidence?: string | null }[] | null | undefined;
  unverifiedScope: string | null | undefined;
}): boolean {
  if ((input.checks ?? []).some(checkDependsOnEvidence)) return true;
  return typeof input.unverifiedScope === "string" && EVIDENCE_TEXT.test(input.unverifiedScope);
}

const FINISHED_INTEGRATION = ["passed", "failed", "needs_check"] as const;
const COMPLETED_REVIEW = ["passed", "needs_check", "failed"];
const ACTIVE_JOB = ["QUEUED", "CLAIMED", "RUNNING"];

export type ReviewReevaluationDecision =
  | { action: "rerun"; integrationAt: string }
  | { action: "fail_stalled"; message: string }
  | {
      action: "none";
      reason:
        | "integration_pending"
        | "integration_unusable"
        | "review_active"
        | "review_in_progress"
        | "not_completed"
        | "execution_failed"
        | "no_evidence_dependency"
        | "already_reevaluated"
        | "used_latest_evidence";
    };

export type ReviewReevaluationInput = {
  review: {
    /** 記録の状態（`viewReleaseVerifications`で読み替える前） */
    state: string;
    /** 実行失敗の診断がある（コードの結果ではない） */
    hasDiagnostic: boolean;
    dependsOnEvidence: boolean;
    marker: ReviewAutoReevaluation | null;
    updatedAt: Date;
  };
  integration: { state: string; updatedAt: Date } | null;
  /** 同じ対象の最新の全体レビュージョブ */
  lastReviewJob: {
    status: string;
    createdAt: Date;
    claimedAt?: Date | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
  } | null;
};

/**
 * 全体レビューを自動で再評価するか。積むのは「統合検証が終わった」「その完了より前に始まったレビューが、証跡に依存する
 * 未確認を残して完走した」「同じ統合検証の完了でまだ積んでいない」がすべて揃ったときだけ。報告の順序（レビュー先行・
 * 統合検証先行）に依らず同じ結論になり、同じ証跡で何度呼ばれても1回しか積まない。
 *
 * 自動で積んだ再評価が報告なしで終わった（取り消し・期限切れ）ときは`fail_stalled`を返し、`waiting`のまま
 * 「確認中」に見せ続けない（手動の再実行へ戻す）。
 */
export function decideReviewReevaluation(input: ReviewReevaluationInput): ReviewReevaluationDecision {
  const { review, integration, lastReviewJob } = input;
  const jobActive = lastReviewJob !== null && ACTIVE_JOB.includes(lastReviewJob.status);

  if (review.state === "waiting" || review.state === "running") {
    if (jobActive) return { action: "none", reason: "review_active" };
    // 自動で積んだのに、ジョブが結果を報告せずに終わった
    if (
      review.marker &&
      lastReviewJob !== null &&
      lastReviewJob.createdAt.getTime() >= Date.parse(review.marker.requestedAt) - 1000
    ) {
      return {
        action: "fail_stalled",
        message: `全体レビューの自動再評価が完了しませんでした（ジョブ: ${lastReviewJob.status}）。「全体レビューを再実行」でやり直してください。`,
      };
    }
    return { action: "none", reason: "review_in_progress" };
  }
  if (jobActive) return { action: "none", reason: "review_active" };
  if (!COMPLETED_REVIEW.includes(review.state)) return { action: "none", reason: "not_completed" };
  if (!integration || integration.state === "waiting" || integration.state === "running") {
    return { action: "none", reason: "integration_pending" };
  }
  if (!(FINISHED_INTEGRATION as readonly string[]).includes(integration.state)) {
    return { action: "none", reason: "integration_unusable" };
  }
  if (review.hasDiagnostic) return { action: "none", reason: "execution_failed" };
  if (!review.dependsOnEvidence) return { action: "none", reason: "no_evidence_dependency" };

  const integrationAt = integration.updatedAt.toISOString();
  if (review.marker && Date.parse(review.marker.integrationAt) >= integration.updatedAt.getTime()) {
    return { action: "none", reason: "already_reevaluated" };
  }
  // レビューが証跡を読んだ時点。ジョブが無い（旧記録）ときは記録の更新時刻で代える
  const reviewStartedAt = lastReviewJob
    ? (lastReviewJob.startedAt ?? lastReviewJob.claimedAt ?? lastReviewJob.createdAt)
    : review.updatedAt;
  if (reviewStartedAt.getTime() >= integration.updatedAt.getTime()) {
    return { action: "none", reason: "used_latest_evidence" };
  }
  return { action: "rerun", integrationAt };
}

/** 全体レビューの残件の種類（要確認の内訳） */
export type ReviewOpenItemKind =
  /** リリースを止める指摘（実装の対応・ユーザーの判断が要る） */
  | "findings"
  /** poller更新・再起動のような運用作業の証跡待ち */
  | "ops"
  /** 統合検証が失敗・要確認で、その結果の確認が要る */
  | "evidence_failed"
  /** 統合検証の結果を取得できない・未実施（成功扱いにしない） */
  | "evidence_unavailable"
  /** 実行結果の証跡を待っている */
  | "evidence_waiting"
  /** 統合検証は成功したが、レビューで確認できない項目が残る */
  | "review_unconfirmed"
  /** 証跡に依存しない未確認の確認項目（統合検証を待っても変わらない。#4767） */
  | "check_unconfirmed"
  /** コードの未読範囲が残っている */
  | "code_unread";

export type ReviewEvidenceStage =
  /** レビュー自体が未実施・対象外・無効。段階は出さない */
  | { kind: "none" }
  /** 統合検証の完了まで開始を待たせている（#4763。レビューはまだ始まっていない） */
  | { kind: "awaiting_integration" }
  /** レビューの実行中（自動再評価ではない） */
  | { kind: "reviewing" }
  /** コード確認は済み、実行結果の証跡（統合検証）を待っている */
  | { kind: "integration_waiting" }
  /** 統合検証の完了を受けて、証跡に依存する項目を再評価している（開始待ちを含む） */
  | { kind: "reevaluating" }
  | { kind: "complete" }
  | { kind: "needs_check"; autoReevaluated: boolean; items: ReviewOpenItemKind[] }
  /** レビューの実行失敗（コードの結果ではない） */
  | { kind: "failed" };

export const REVIEW_STAGE_LABEL: Record<ReviewEvidenceStage["kind"], string> = {
  none: "",
  awaiting_integration: "統合検証の完了待ち",
  reviewing: "全体レビュー中",
  integration_waiting: "コード確認済み・統合検証待ち",
  reevaluating: "検証結果を確認中",
  complete: "全体レビュー完了",
  needs_check: "全体レビュー要確認",
  failed: "全体レビュー失敗",
};

export const REVIEW_OPEN_ITEM_LABEL: Record<ReviewOpenItemKind, string> = {
  findings: "対応・判断が必要な指摘",
  ops: "運用作業（poller更新・再起動）の証跡待ち",
  evidence_failed: "統合検証の失敗・要確認の結果",
  evidence_unavailable: "統合検証の結果を取得できない・未実施",
  evidence_waiting: "実行結果の証跡待ち",
  review_unconfirmed: "レビューの未確認事項（統合検証は成功）",
  check_unconfirmed: "証跡に依存しない未確認の確認項目",
  code_unread: "コードの未確認範囲",
};

export function describeReviewStageLabel(stage: ReviewEvidenceStage): string {
  if (stage.kind === "needs_check" && stage.autoReevaluated) return "自動再評価済み・対応／判断が必要";
  return REVIEW_STAGE_LABEL[stage.kind];
}

export type ReviewStageInput = {
  /** 表示上の状態（`viewReleaseVerifications`の読み替え後。`running`はジョブが動いているとき） */
  state: string;
  updatedAt: string | null;
  findingsCount: number;
  checks: readonly { status: string; evidence?: string | null }[] | null;
  openFiles: number;
  unverifiedScope: string | null;
  reason: string | null;
  summary: string | null;
  autoReevaluation: ReviewAutoReevaluation | null;
  /** 実行失敗の診断がある（レビューを完走できていない） */
  executionFailed: boolean;
  /** 統合検証の完了まで開始を待たせている印がある（#4763。`findings.awaitingIntegration`） */
  awaitingIntegration?: boolean;
};

/**
 * 全体レビューの共通の段階（#4664）。上部バッジ・説明・詳細・本番確認が同じ値を出す。
 * **完了した統合検証を「実行中」と出さない**——統合検証が終わってレビューが古い証跡のままなら、それは
 * 「検証結果を確認中」（自動再評価の開始待ち）であり、統合検証の実行中ではない。
 */
export function describeReviewEvidenceStage(
  review: ReviewStageInput,
  integration: { state: string; updatedAt: string | null },
): ReviewEvidenceStage {
  const integrationPending = integration.state === "waiting" || integration.state === "running";
  const integrationFinished = (FINISHED_INTEGRATION as readonly string[]).includes(integration.state);
  const marker = review.autoReevaluation;
  const markerCurrent =
    marker !== null &&
    integration.updatedAt !== null &&
    Date.parse(marker.integrationAt) >= Date.parse(integration.updatedAt);

  // 統合検証の完了まで開始を待たせている（#4763）。統合検証が終わった後は、開始されるまで「全体レビュー中」として出す
  if (review.state === "waiting" && review.awaitingIntegration && integrationPending) return { kind: "awaiting_integration" };
  if (review.state === "waiting" || review.state === "running") {
    return marker !== null && integrationFinished ? { kind: "reevaluating" } : { kind: "reviewing" };
  }
  if (review.state === "failed" && (review.executionFailed || (review.findingsCount === 0 && review.checks === null))) {
    return { kind: "failed" };
  }
  if (review.state !== "passed" && review.state !== "needs_check" && review.state !== "failed") return { kind: "none" };

  const dependsOnEvidence = reviewDependsOnEvidence(review);
  if (review.state !== "passed" || dependsOnEvidence || review.openFiles > 0 || review.unverifiedScope) {
    if (dependsOnEvidence && integrationPending) {
      // 指摘が別にあれば要確認を優先する（待てば進むとは見せない）
      if (review.findingsCount === 0) return { kind: "integration_waiting" };
    }
    // 統合検証が完了したのに、レビューはそれより前の証跡のまま。自動再評価が積まれるまでの間
    if (
      dependsOnEvidence &&
      integrationFinished &&
      !markerCurrent &&
      integration.updatedAt !== null &&
      review.updatedAt !== null &&
      Date.parse(integration.updatedAt) > Date.parse(review.updatedAt)
    ) {
      return { kind: "reevaluating" };
    }
  }
  if (review.state === "passed" && !review.unverifiedScope && review.findingsCount === 0) return { kind: "complete" };

  const items: ReviewOpenItemKind[] = [];
  if (review.findingsCount > 0) items.push("findings");
  const unconfirmed = (review.checks ?? []).filter((c) => c.status === "unconfirmed");
  const unconfirmedTexts = unconfirmed.map((c) => c.evidence ?? null);
  if (findOpsRequest([review.reason, review.unverifiedScope, ...unconfirmedTexts])) items.push("ops");
  if (dependsOnEvidence) {
    if (integration.state === "failed" || integration.state === "needs_check") items.push("evidence_failed");
    else if (integrationPending) items.push("evidence_waiting");
    else if (integration.state !== "passed") items.push("evidence_unavailable");
    // 未確認項目が残ることと、成功済みの統合検証が未実施であることは異なる。
    else items.push("review_unconfirmed");
  }
  // 証跡にも運用作業にも当たらない未確認（読み切れなかった観点など）。再評価では変わらないので別に出す
  if (unconfirmed.some((c) => !checkDependsOnEvidence(c) && !findOpsRequest([c.evidence ?? null]))) {
    items.push("check_unconfirmed");
  }
  if (review.openFiles > 0) items.push("code_unread");
  return { kind: "needs_check", autoReevaluated: markerCurrent, items };
}
