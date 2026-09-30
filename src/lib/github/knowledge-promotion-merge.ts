/** 共通知識の反映PRの自動マージ（#3645）の純粋な判定。IOは`knowledge-promotion-merge-run.ts` */

export const PROMOTION_MERGE_DEFAULT_INTERVAL_MINUTES = 10;

/** 巡回の間隔（分）。数値でなければ既定値。**0以下は「巡回しない」** */
export function promotionMergeIntervalMinutes(
  raw: string | undefined = process.env.KNOWLEDGE_PROMOTION_MERGE_INTERVAL_MINUTES,
): number {
  if (raw === undefined || raw.trim() === "") return PROMOTION_MERGE_DEFAULT_INTERVAL_MINUTES;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return PROMOTION_MERGE_DEFAULT_INTERVAL_MINUTES;
  return value;
}

export type PromotionMergeDecision = "merge" | "skip_pending" | "skip_blocked";

/**
 * `GET /pulls/{n}`の`mergeable_state`からマージしてよいかを決める。
 * `clean`（と、フックだけが残る`has_hooks`）のみ。`unknown`・`unstable`は結果待ち／失敗で、
 * `dirty`・`blocked`・`behind`・`draft`は人が見ないと進まない。
 */
export function decidePromotionMerge(pull: {
  draft?: boolean;
  mergeable_state?: string | null;
}): PromotionMergeDecision {
  if (pull.draft) return "skip_blocked";
  switch (pull.mergeable_state) {
    case "clean":
    case "has_hooks":
      return "merge";
    case "unknown":
    case undefined:
    case null:
      return "skip_pending";
    default:
      return "skip_blocked";
  }
}
