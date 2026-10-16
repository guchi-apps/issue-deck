import {
  assessReleaseOps,
  findOpsRequest,
  opsRequestTexts,
  type ReleaseOpsAssessment,
} from "@/lib/release-review-ops-evidence";
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
    };

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
): ReviewRerunView {
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
          ? "サブPCの更新は不要"
          : ops.status === "updated"
            ? "サブPCは更新済み"
            : ops.status === "needed"
              ? ops.timing === "before_release"
                ? "サブPCの更新が必要（公開前）"
                : "サブPCの更新が必要（公開後でよい）"
              : "状態を確認できません",
    });
  }

  // 自動再評価（#4664）。統合検証が完了すると、証跡に依存する項目だけをサーバーが自動で再評価する
  const stage = aiReview.stage;
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
  };
}
