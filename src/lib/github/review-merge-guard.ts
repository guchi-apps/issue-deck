import { needsReviewAttention, parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { resolveReviewVerdictFreshness } from "@/lib/github/review-verdict-freshness";

export type ReviewMergeGuardResult =
  | { status: "ok" }
  /** 要修正・要確認の判定が残っていて、このHEADへの例外確認が無い */
  | {
      status: "review_confirmation_required";
      reviewLabel: string;
      reviewKind: string;
      headSha: string;
      /** 確認が古いHEADのものだったとき（再提示させる） */
      acknowledgedStale: boolean;
    };

/**
 * 要修正・要確認のPRを、確認なしの通常のマージ要求で通さないためのサーバー側の判定（#4377）。
 *
 * 判定の材料はUIと同じPR本文の`## 検証結果`で、鮮度も同じ純関数で出す。**止めるのは判定が
 * `current`または`unknown`のときだけ**——`stale`（判定の後にコミットが積まれた）は再レビュー待ちの
 * 正常な窓なので塞がない（画面側は警告を維持する）。判定が読めない（本文が無い・節が無い）PRは
 * 要修正と確定できないため塞がない。例外確認はHEADのSHAに紐付け、HEADが変わったら無効になる。
 */
export function evaluateReviewMergeGuard(params: {
  body: string | null | undefined;
  headSha: string;
  acknowledgeReviewSha: string | undefined;
}): ReviewMergeGuardResult {
  const verdict = parsePullRequestReviewVerdict(params.body);
  if (!verdict || !needsReviewAttention(verdict.reviewKind)) return { status: "ok" };
  const freshness = resolveReviewVerdictFreshness({
    reviewedSha: verdict.reviewedSha,
    headSha: params.headSha,
  });
  if (freshness === "stale") return { status: "ok" };
  const ack = params.acknowledgeReviewSha;
  if (ack && ack.toLowerCase() === params.headSha.toLowerCase()) return { status: "ok" };
  return {
    status: "review_confirmation_required",
    reviewLabel: verdict.reviewLabel,
    reviewKind: verdict.reviewKind,
    headSha: params.headSha,
    acknowledgedStale: Boolean(ack),
  };
}
