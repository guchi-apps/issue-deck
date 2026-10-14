import type { ReleaseVerificationSection } from "@/lib/release-verification-summary";

/**
 * 全体レビュー欄の「再実行」導線の出し分け（#4632）。画面（`release-review-sections.tsx`）は結果の状態から
 * 次の操作を決めるだけにして、判断はここへ寄せる。
 *
 * - 実行失敗（`failed`）・確認範囲不足や検証結果待ち（`needs_check`）のときだけ再実行を出す
 * - 統合検証が実行中・結果待ちの間は、途中の証跡で同じレビューを繰り返させない（押せない・理由を出す）。
 *   再実行のために統合検証を起動することもしない
 * - poller更新・再起動のような運用証跡の不足は、コードへの指摘でもレビューCLIの認証失敗でもない。
 *   再実行では解決しない旨と、必要なホスト確認を出す。**確認できない事実を確認済みにしない**
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
      /** 運用証跡（poller更新・再起動など）が不足していそうなとき、再実行だけでは直らない旨と次の確認 */
      opsEvidence: string | null;
    };

/** 未確認の理由が運用証跡（poller更新・再起動）の不足を指しているか */
export function mentionsOpsEvidence(texts: readonly (string | null | undefined)[]): boolean {
  return texts.some((t) => typeof t === "string" && /poller|ポーラー|再起動/i.test(t));
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
): ReviewRerunView {
  if (aiReview.state !== "failed" && aiReview.state !== "needs_check") return { kind: "none" };

  const integrationPending = integration.state === "waiting" || integration.state === "running";
  const integrationFinished = ["passed", "failed", "needs_check"].includes(integration.state);
  // 統合検証が全体レビューより新しく終わっていれば、再実行で新しい証跡を使える
  const evidenceNewer =
    integrationFinished &&
    integration.updatedAt !== null &&
    (aiReview.updatedAt === null || Date.parse(integration.updatedAt) > Date.parse(aiReview.updatedAt));

  const openCount = aiReview.coverage?.open.length ?? 0;
  const unconfirmedChecks = aiReview.review?.checks.filter((c) => c.status === "unconfirmed").length ?? 0;
  const opsText = mentionsOpsEvidence([
    aiReview.reason,
    aiReview.summary,
    ...(aiReview.review?.checks.filter((c) => c.status === "unconfirmed").map((c) => c.evidence) ?? []),
  ]);
  // 実行失敗の診断（CLI認証など）は運用証跡の不足とは別。診断があるものは混ぜない
  const opsEvidence =
    opsText && aiReview.state === "needs_check"
      ? "サブPCのpoller更新・再起動の証跡が確認できていません。再実行だけでは解決しません。サブPCで「更新して再起動」を実行し、その結果を確認してから再実行してください。確認できるまで、この項目は未確認のまま残ります。"
      : null;

  const prerequisites: ReviewRerunPrerequisite[] = [
    {
      label: "統合検証",
      status: integrationPending ? "pending" : integration.state === "passed" ? "ok" : "missing",
      text: INTEGRATION_TEXT[integration.state] ?? integration.state,
    },
  ];
  if (aiReview.state === "needs_check") {
    prerequisites.push({
      label: "未確認の項目",
      status: openCount + unconfirmedChecks > 0 ? "missing" : "pending",
      text:
        openCount + unconfirmedChecks > 0
          ? `未確認の対象${openCount}件・未確認の確認項目${unconfirmedChecks}件`
          : (aiReview.reason ?? "未確認の範囲があります"),
    });
  }

  if (integrationPending) {
    return {
      kind: "wait",
      lead: "統合検証の完了を待っています。途中の証跡では再評価しません。完了すると再実行できます。",
      buttonLabel: "全体レビューを再実行（検証完了後）",
      prerequisites,
      opsEvidence,
    };
  }
  return {
    kind: "ready",
    lead: evidenceNewer
      ? "統合検証が完了しています。更新された証跡で未確認の項目を再評価します。確認済みの結果は再利用し、修正Issue・PR・候補は増えません。"
      : aiReview.state === "failed"
        ? "レビューを最後まで行えていません。同じ対象でやり直します。修正Issue・PR・候補は増えません。"
        : "同じ対象で未確認の項目を再評価します。確認済みの結果は再利用し、修正Issue・PR・候補は増えません。",
    buttonLabel: evidenceNewer ? "全体レビューを再実行（証跡を更新）" : "全体レビューを再実行",
    prerequisites,
    opsEvidence,
  };
}
