import {
  POLLER_REPOSITORY,
  findOpsRequest,
  type ReleaseOpsAssessment,
  type ReleaseOpsHostFact,
} from "@/lib/release-review-ops-evidence";

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
 * 記録の`findings.hostFacts`。全体レビューを実行したホストと、その時点の起動時コミット（#5111）。
 * 結果の報告時にサーバーが記録する。ランナーの`runner_host_fingerprint`と同じく、チェックアウトの現在のHEADは含めない
 */
export type ReviewHostFacts = { host: string; startedCommit: string | null };

/** 記録の`findings.opsReevaluation`。pollerの稼働事実（`hostFact`）ごとに1回だけ自動で積んだ印（#5111） */
export type ReviewOpsReevaluation = {
  /** 再評価の契機にしたホストの事実（`hostFactKey`） */
  hostFact: string;
  /** 積んだ時刻（ISO） */
  requestedAt: string;
};

export function hostFactKey(host: string, startedCommit: string | null): string {
  return `${host}@${startedCommit ?? ""}`;
}

function readObject(findings: unknown, key: string): Record<string, unknown> | null {
  const raw =
    typeof findings === "object" && findings !== null && !Array.isArray(findings)
      ? (findings as Record<string, unknown>)[key]
      : null;
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

export function readHostFacts(findings: unknown): ReviewHostFacts | null {
  const r = readObject(findings, "hostFacts");
  if (!r || typeof r.host !== "string") return null;
  return { host: r.host, startedCommit: typeof r.startedCommit === "string" ? r.startedCommit : null };
}

export function readOpsReevaluation(findings: unknown): ReviewOpsReevaluation | null {
  const r = readObject(findings, "opsReevaluation");
  if (!r || typeof r.hostFact !== "string" || typeof r.requestedAt !== "string") return null;
  return { hostFact: r.hostFact, requestedAt: r.requestedAt };
}

/**
 * 実行結果（テスト・型検査・ビルド）の証跡を指す未確認の文言。
 * **ランナー（`scripts/run-release-review.sh`の`EVIDENCE_TEXT_PATTERN`）と同じ語を持つ**（変えるときは両方を揃える）
 */
const EVIDENCE_TEXT = /統合検証|検証結果|検証証跡|証跡|実行結果|テスト|型検査|ビルド|running|連携先|資料未取得|権限不足|通信失敗|実設定不足|資料にありません|固定SHA|適用手順|デプロイ設定/i;

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
    /** pollerの稼働事実の変化で自動で積んだ印（#5111）。停滞の判定にだけ使う */
    opsMarker?: ReviewOpsReevaluation | null;
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
    // 自動で積んだのに、ジョブが結果を報告せずに終わった（統合検証・pollerの更新のどちらを契機にしたものでも）
    const requestedAt = Math.max(
      review.marker ? Date.parse(review.marker.requestedAt) : Number.NEGATIVE_INFINITY,
      review.opsMarker ? Date.parse(review.opsMarker.requestedAt) : Number.NEGATIVE_INFINITY,
    );
    if (lastReviewJob !== null && Number.isFinite(requestedAt) && lastReviewJob.createdAt.getTime() >= requestedAt - 1000) {
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

export type OpsReevaluationSkipReason =
  /** 運用待ち（poller更新・再起動の未確認）の要確認ではない。案内も出さない */
  | "not_waiting_ops"
  | "execution_failed"
  | "review_active"
  | "ops_not_needed"
  | "ops_needed"
  | "ops_unknown"
  | "verify_host_not_updated"
  | "no_eligible_host"
  | "same_host_facts"
  | "already_reevaluated";

export type OpsReevaluationDecision =
  | { action: "rerun"; host: string; hostFact: string }
  | { action: "none"; reason: OpsReevaluationSkipReason };

/** 自動で開始しない理由の説明（画面用）。`not_waiting_ops`は案内しない */
export const OPS_REEVALUATION_SKIP_TEXT: Record<OpsReevaluationSkipReason, string> = {
  not_waiting_ops: "",
  execution_failed: "全体レビューを最後まで実行できていないため、自動では再評価しません。",
  review_active: "全体レビューを実行中です。終わるまで自動の再評価は積みません。",
  ops_not_needed: "この候補はサブPCの更新が不要なため、pollerの更新を契機には再評価しません。",
  ops_needed: "サブPCのpollerが候補を含む版で動き出すのを待っています。更新・再起動を確認すると自動で再評価します。",
  ops_unknown: "サブPCの稼働状態（オンラインか・起動時のコミット）を確認できないため、自動では開始しません。",
  verify_host_not_updated:
    "統合検証の証跡を持つサブPCが、更新済み・全体レビュー対応・オンラインのいずれかを満たさないため、自動では開始しません。",
  no_eligible_host: "更新済みで全体レビューを実行できるサブPCが無いため、自動では開始しません。",
  same_host_facts: "このレビューは、いま稼働しているpollerの版で実行済みです。同じ事実では結果が変わらないため、自動では再実行しません。",
  already_reevaluated: "いま稼働しているpollerの版で自動再評価済みです。残っている項目は対応・判断が必要です。",
};

export type OpsReevaluationInput = {
  repositoryFullName: string;
  review: {
    /** 記録の状態（読み替える前） */
    state: string;
    hasDiagnostic: boolean;
    /** 未確認がpollerの更新・再起動の要求を含み（`findOpsRequest`）、ランナーがホストの事実で見直す対象か（`reviewDependsOnHost`） */
    waitsForOps: boolean;
    /** 統合検証の証跡にも依存するか。依存するなら証跡を持つホストでしか再評価できない */
    dependsOnEvidence: boolean;
    hostFacts: ReviewHostFacts | null;
    opsMarker: ReviewOpsReevaluation | null;
  };
  /** 同じ対象の全体レビュージョブが待機中・実行中か */
  jobActive: boolean;
  /** 稼働情報と照らした運用状態（`assessReleaseOps`）。照合できなければnull */
  assessment: ReleaseOpsAssessment | null;
  hosts: readonly ReleaseOpsHostFact[];
  /** 統合検証を実行したホスト（証跡に依存するときの実行先）。分からなければnull */
  verifyHost: string | null;
};

/**
 * pollerの稼働事実の変化を契機に、運用待ちの全体レビューを自動で再評価するか（#5111）。積むのは
 * 「運用待ちの要確認」「照合で更新済み（`updated`）」「更新済みで全体レビューを実行できるホストがある」
 * 「そのホストの事実（起動時コミット）がレビューの実行時と違う」「同じ事実でまだ積んでいない」が揃ったときだけ。
 * heartbeatの反復や「最新」表示では事実が変わらないので積まない。結果の記録に事実が無い旧結果は、事実が違うものとして1回だけ積む
 */
export function decideOpsReevaluation(input: OpsReevaluationInput): OpsReevaluationDecision {
  const { review, assessment } = input;
  if (review.state !== "needs_check" || !review.waitsForOps) return { action: "none", reason: "not_waiting_ops" };
  if (review.hasDiagnostic) return { action: "none", reason: "execution_failed" };
  if (input.jobActive) return { action: "none", reason: "review_active" };
  if (!assessment || assessment.status === "unknown") return { action: "none", reason: "ops_unknown" };
  if (assessment.status === "not_needed") return { action: "none", reason: "ops_not_needed" };
  if (assessment.status === "needed") return { action: "none", reason: "ops_needed" };

  const isPollerRepo = input.repositoryFullName === POLLER_REPOSITORY;
  let eligible = input.hosts
    .filter(
      (h) =>
        h.online &&
        h.releaseReviewCapable &&
        (isPollerRepo ? h.includesCandidate === true : h.releaseVerifyCapable),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  if (review.dependsOnEvidence) {
    eligible = eligible.filter((h) => h.name === input.verifyHost);
    if (eligible.length === 0) return { action: "none", reason: "verify_host_not_updated" };
  }
  if (eligible.length === 0) return { action: "none", reason: "no_eligible_host" };

  const saved = review.hostFacts ? hostFactKey(review.hostFacts.host, review.hostFacts.startedCommit) : null;
  const fresh = eligible.find((h) => hostFactKey(h.name, h.startedCommit) !== saved);
  if (!fresh) return { action: "none", reason: "same_host_facts" };
  const hostFact = hostFactKey(fresh.name, fresh.startedCommit);
  if (review.opsMarker?.hostFact === hostFact) return { action: "none", reason: "already_reevaluated" };
  return { action: "rerun", host: fresh.name, hostFact };
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
  /**
   * 統合検証の完了を受けて、証跡に依存する項目を再評価している（開始待ちを含む）。
   * `trigger: "ops"`はpollerの更新（稼働事実の変化）を契機にした再評価（#5111）
   */
  | { kind: "reevaluating"; trigger?: "ops" }
  | { kind: "complete" }
  | {
      kind: "needs_check";
      autoReevaluated: boolean;
      items: ReviewOpenItemKind[];
      /**
       * 残件が止める指摘だけで、その全件に有効な非修正の判断（公開後対応・見送り・不採用）がある（#4814）。
       * 合否（`needs_check`）は変えず、画面が赤の「対応／判断が必要」を出さないための印
       */
      cleared?: boolean;
    }
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

/** 判断済み（#4814）の段階の名前 */
export const REVIEW_DECIDED_LABEL = "判断済み（公開後対応）";

export function describeReviewStageLabel(stage: ReviewEvidenceStage): string {
  if (stage.kind === "needs_check" && stage.cleared) return REVIEW_DECIDED_LABEL;
  if (stage.kind === "needs_check" && stage.autoReevaluated) return "自動再評価済み・対応／判断が必要";
  if (stage.kind === "reevaluating" && stage.trigger === "ops") return "poller更新を受けて再評価中";
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
  /** pollerの稼働事実の変化で自動で積んだ印（#5111） */
  opsReevaluation?: ReviewOpsReevaluation | null;
  /** 結果を出したホストの事実（#5111）。印と同じ事実なら、その再評価の結果 */
  hostFacts?: ReviewHostFacts | null;
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
  const opsMarker = review.opsReevaluation ?? null;
  if (review.state === "waiting" || review.state === "running") {
    // 後から積んだ方の契機を出す
    if (opsMarker && (marker === null || Date.parse(opsMarker.requestedAt) >= Date.parse(marker.requestedAt))) {
      return { kind: "reevaluating", trigger: "ops" };
    }
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
  const opsReevaluated =
    opsMarker !== null &&
    review.hostFacts != null &&
    opsMarker.hostFact === hostFactKey(review.hostFacts.host, review.hostFacts.startedCommit);
  return { kind: "needs_check", autoReevaluated: markerCurrent || opsReevaluated, items };
}

/**
 * 判断の要約（`ReleaseReviewDecisionSummary.cleared`）を段階へ反映する（#4814）。残件が止める指摘だけのときに限り
 * `cleared`を付ける——運用作業・未読範囲・証跡の未確認は、指摘への判断では解消しないので従来どおり要確認のまま
 */
export function applyReviewDecisionsToStage(
  stage: ReviewEvidenceStage | undefined,
  decisions: { cleared: boolean } | null | undefined,
): ReviewEvidenceStage | undefined {
  if (!stage || stage.kind !== "needs_check" || !decisions?.cleared) return stage;
  if (!stage.items.every((item) => item === "findings")) return stage;
  return { ...stage, cleared: true };
}
