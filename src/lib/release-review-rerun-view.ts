import {
  assessReleaseOps,
  findOpsRequest,
  opsRequestTexts,
  type ReleaseOpsAssessment,
} from "@/lib/release-review-ops-evidence";
import { OPS_REEVALUATION_SKIP_TEXT } from "@/lib/release-review-reevaluation";
import { viewReleaseProgress } from "@/lib/release-verification-progress";
import type { ReleaseVerificationSection } from "@/lib/release-verification-summary";

/**
 * 全体レビュー欄の「再実行」導線の出し分け（#4632）。画面（`release-review-sections.tsx`）は結果の状態から
 * 次の操作を決めるだけにして、判断はここへ寄せる。
 *
 * - 実行失敗（`failed`）・確認範囲不足や検証結果待ち（`needs_check`）のときだけ再実行を出す
 * - 統合検証が実行中・結果待ちの間は、途中の証跡で同じレビューを繰り返させない（押せない・理由を出す）。
 *   再実行のために統合検証を起動することもしない
 * - 前提は「コードの確認（読み残し）」「統合検証」「運用状態の確認」に分ける（#4665）。運用状態は、レビューが
 *   pollerの更新・再起動を**要求したときだけ**、稼働情報と照らして「不要／更新済み／更新が必要／確認できない」を出す
 *   （`release-review-ops-evidence.ts`）。単語の一致だけで更新を要求しない。**確認できない事実を確認済みにしない**
 * - 記録が`waiting`のまま進まない全体レビュー（#5480）にも再実行を出す。直前のジョブが結果を記録しないまま終わった
 *   （`interrupted`）か、ジョブが無いまま一定時間たった（`no_job`）ときで、どちらも待っても自動では始まらない。
 *   統合検証の完了待ちの印（`awaitingIntegration`）が付いた正規の待機は、巡回が開始するので対象にしない
 */

export type ReviewRerunPrerequisite = { label: string; status: "ok" | "pending" | "missing"; text: string };

export type ReviewRerunView =
  | { kind: "none" }
  | {
      kind: "wait" | "ready";
      /** 押したときの動作の説明（受付は合格ではない） */
      lead: string;
      buttonLabel: string;
      prerequisites: ReviewRerunPrerequisite[];
      /** レビューがpollerの更新・再起動を要求したときの照合結果。要求が無ければnull */
      ops: ReleaseOpsAssessment | null;
      /**
       * pollerの更新後の自動再評価（#5111）の状況。開始予定か、自動で開始しない理由。
       * 運用待ちでない・判定を読めなかったときはnull
       */
      opsAuto?: { status: "scheduled" | "blocked"; text: string } | null;
      /** 開始待ちのまま進まない全体レビューの回復（#5480）。通常の再実行ではnull・省略 */
      recovery?: ReviewStuckReason | null;
    };

/** ジョブが無いまま`waiting`の記録を、進まないとみなすまでの時間。依頼直後（記録の作成→ジョブの投入）の間は出さない */
export const REVIEW_STUCK_NO_JOB_MS = 10 * 60_000;

/**
 * 開始待ちのまま進まない理由（#5480）。`interrupted`は直前のジョブが結果なしで終了・取り消し済み、
 * `no_job`はジョブが1件も無いまま`REVIEW_STUCK_NO_JOB_MS`以上たった
 */
export type ReviewStuckReason = "interrupted" | "no_job";

/**
 * 全体レビューが開始待ちのまま進まないか（#5480）。統合検証の「再開」（`decideIntegrationResume`）と同じく、
 * 記録の状態とジョブから作った進捗の両方を見る。待機中・実行中・応答なし（ジョブは生きている）は対象にしない
 */
export function detectStuckReview(
  aiReview: Pick<ReleaseVerificationSection, "state" | "progress" | "updatedAt" | "awaitingIntegration">,
  nowMs: number,
): ReviewStuckReason | null {
  if (aiReview.state !== "waiting" && aiReview.state !== "running") return null;
  // 統合検証の完了まで待たせている正規の待機。開始は巡回（`sweepDeferredReleaseReviews`）が受け持つ
  if (aiReview.awaitingIntegration) return null;
  if (aiReview.progress) {
    const phase = viewReleaseProgress(aiReview.progress, nowMs).phase;
    return phase === "canceled" || phase === "ended" ? "interrupted" : null;
  }
  const since = aiReview.updatedAt !== null ? Date.parse(aiReview.updatedAt) : Number.NaN;
  return Number.isFinite(since) && nowMs - since >= REVIEW_STUCK_NO_JOB_MS ? "no_job" : null;
}

const INTEGRATION_TEXT: Record<string, string> = {
  passed: "完了・問題なし",
  failed: "失敗（検証結果は証跡に記録済み）",
  needs_check: "完了・要確認",
  not_run: "未実施",
  not_applicable: "対象外",
  waiting: "待機中・結果待ち",
  running: "実行中・結果待ち",
  invalidated: "対象が変わったため無効",
};

export function describeReviewRerun(
  aiReview: ReleaseVerificationSection,
  integration: ReleaseVerificationSection,
  /** 進まない開始待ち（#5480）の判定に使う現在時刻。省略時は開始待ちに再実行を出さない */
  nowMs?: number,
): ReviewRerunView {
  if (aiReview.state === "waiting" || aiReview.state === "running") {
    const stuck = nowMs === undefined ? null : detectStuckReview(aiReview, nowMs);
    return stuck ? describeStuckRerun(stuck, integration) : { kind: "none" };
  }
  if (aiReview.state !== "failed" && aiReview.state !== "needs_check") return { kind: "none" };

  const integrationPending = integration.state === "waiting" || integration.state === "running";
  const integrationFinished = ["passed", "failed", "needs_check"].includes(integration.state);
  // 統合検証が全体レビューより新しく終わっていれば、再実行で新しい証跡を使える
  const evidenceNewer =
    integrationFinished &&
    integration.updatedAt !== null &&
    (aiReview.updatedAt === null || Date.parse(integration.updatedAt) > Date.parse(aiReview.updatedAt));

  // 運用（poller）の要求だけを根拠にした未確認の項目は、コードの読み残しに数えない
  const unconfirmed = aiReview.review?.checks.filter((c) => c.status === "unconfirmed") ?? [];
  const codeUnconfirmed = unconfirmed.filter((c) => !findOpsRequest([c.evidence])).length;
  const openCount = aiReview.coverage?.open.length ?? 0;
  // 実行失敗の診断（CLI認証など）は運用状態とは別。診断があるものは混ぜない
  const ops = aiReview.state === "needs_check" ? assessReleaseOps(findOpsRequest(opsRequestTexts(aiReview)), aiReview.opsContext) : null;

  const prerequisites: ReviewRerunPrerequisite[] = [];
  if (aiReview.state === "needs_check") {
    const codeCount = openCount + codeUnconfirmed;
    prerequisites.push({
      label: "コードの確認",
      status: codeCount > 0 ? "missing" : ops ? "ok" : "pending",
      text:
        codeCount > 0
          ? `読み残し: 未確認の対象${openCount}件・未確認の確認項目${codeUnconfirmed}件`
          : ops
            ? "読み残しはありません"
            : (aiReview.reason ?? "未確認の範囲があります"),
    });
  }
  prerequisites.push({
    label: "統合検証",
    status: integrationPending ? "pending" : integration.state === "passed" ? "ok" : "missing",
    text: INTEGRATION_TEXT[integration.state] ?? integration.state,
  });
  if (ops) {
    // 統合検証の成功では運用状態を確認済みにしない。照合で分かったことだけで決める
    prerequisites.push({
      label: "運用状態の確認",
      status:
        ops.status === "not_needed" || ops.status === "updated"
          ? "ok"
          : ops.status === "needed" && ops.timing === "before_release"
            ? "missing"
            : "pending",
      text:
        ops.status === "not_needed"
          ? "DeskMiniの更新は不要"
          : ops.status === "updated"
            ? "DeskMiniは更新済み"
            : ops.status === "needed"
              ? ops.timing === "before_release"
                ? "DeskMiniの更新が必要（公開前）"
                : "DeskMiniの更新が必要（公開後でよい）"
              : "状態を確認できません",
    });
  }

  const opsAuto = describeOpsAuto(aiReview.opsAutoReevaluation);

  // 自動再評価（#4664）。統合検証が完了すると、証跡に依存する項目だけをサーバーが自動で再評価する
  const stage = aiReview.stage;
  if (stage?.kind === "reevaluating" && stage.trigger === "ops") {
    return {
      kind: "wait",
      lead: "DeskMiniのpollerが候補を含む版で動き出したため、運用状態に依存する項目を自動で再評価しています（開始待ちを含む）。確認済みの結果は再利用します。手動の操作は不要です。",
      buttonLabel: "全体レビューを再実行（自動再評価中）",
      prerequisites,
      ops,
      opsAuto: null,
    };
  }
  if (stage?.kind === "reevaluating") {
    return {
      kind: "wait",
      lead: "統合検証が完了したため、その結果に依存する項目を自動で再評価しています（開始待ちを含む）。手動の操作は不要です。",
      buttonLabel: "全体レビューを再実行（自動再評価中）",
      prerequisites,
      ops,
    };
  }
  if (integrationPending) {
    return {
      kind: "wait",
      lead:
        stage?.kind === "integration_waiting"
          ? "コード確認は済んでいます。統合検証が完了すると、その結果に依存する項目を自動で再評価します（手動の操作は不要です）。"
          : "統合検証の完了を待っています。途中の証跡では再評価しません。完了すると自動で再評価します。",
      buttonLabel: "全体レビューを再実行（検証完了後）",
      prerequisites,
      ops,
      opsAuto,
    };
  }
  const autoReevaluated = stage?.kind === "needs_check" && stage.autoReevaluated;
  return {
    kind: "ready",
    lead: autoReevaluated
      ? "最新の統合検証の結果で自動再評価済みです。残っている項目は対応・判断が必要です。再実行は回復用で、同じ証跡では結果が変わらないことがあります。"
      : evidenceNewer
      ? "統合検証が完了しています。更新された証跡で未確認の項目を再評価します。確認済みの結果は再利用し、修正Issue・PR・候補は増えません。"
      : aiReview.state === "failed"
        ? "レビューを最後まで行えていません。同じ対象でやり直します。修正Issue・PR・候補は増えません。"
        : "同じ対象で未確認の項目を再評価します。確認済みの結果は再利用し、修正Issue・PR・候補は増えません。",
    buttonLabel: evidenceNewer ? "全体レビューを再実行（証跡を更新）" : "全体レビューを再実行",
    prerequisites,
    ops,
    opsAuto,
  };
}

const STUCK_TEXT: Record<ReviewStuckReason, string> = {
  interrupted: "前回の実行が結果を記録しないまま終了し、次の実行は始まっていません",
  no_job: `開始待ちのまま${REVIEW_STUCK_NO_JOB_MS / 60_000}分以上、実行のジョブが作られていません`,
};

function describeStuckRerun(reason: ReviewStuckReason, integration: ReleaseVerificationSection): ReviewRerunView {
  const integrationPending = integration.state === "waiting" || integration.state === "running";
  const prerequisites: ReviewRerunPrerequisite[] = [
    { label: "前回の実行", status: "missing", text: STUCK_TEXT[reason] },
    {
      label: "統合検証",
      status: integrationPending ? "pending" : integration.state === "passed" ? "ok" : "missing",
      text: INTEGRATION_TEXT[integration.state] ?? integration.state,
    },
  ];
  if (integrationPending) {
    // 再実行の受け口（`review-rerun`）は統合検証の結果待ちを受け付けない。待っても自動では始まらないことを隠さない
    return {
      kind: "wait",
      lead: `${STUCK_TEXT[reason]}。待っても自動では始まりません。統合検証が完了したら「全体レビューを再実行」で開始し直してください。`,
      buttonLabel: "全体レビューを再実行（検証完了後）",
      prerequisites,
      ops: null,
      recovery: reason,
    };
  }
  return {
    kind: "ready",
    lead: `${STUCK_TEXT[reason]}。待っても自動では始まらないため、同じ対象で開始し直してください。修正Issue・PR・候補は増えません。`,
    buttonLabel: "全体レビューを再実行",
    prerequisites,
    ops: null,
    recovery: reason,
  };
}

function describeOpsAuto(
  decision: ReleaseVerificationSection["opsAutoReevaluation"],
): { status: "scheduled" | "blocked"; text: string } | null {
  if (!decision) return null;
  if (decision.action === "rerun") {
    return {
      status: "scheduled",
      text: "DeskMiniは更新済みです。次の巡回（1分程度）で、運用状態に依存する項目を自動で再評価します。",
    };
  }
  if (decision.reason === "not_waiting_ops") return null;
  return {
    status: "blocked",
    text: `${OPS_REEVALUATION_SKIP_TEXT[decision.reason]}必要なら「全体レビューを再実行」で手動でやり直せます。`,
  };
}
