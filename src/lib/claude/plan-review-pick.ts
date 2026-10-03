import { askSystemOne, readNoulAnswer } from "@/lib/typesafe/system-one";

/**
 * 計画レビュー（G1）の指摘を計画へ取り込むべきかをJevに判断させる（#3648）。**判断できなければ`null`。**
 *
 * `null`はキー未設定・呼び出しの失敗・答えの形が違うときで、呼び出し元（`plan-review-auto-reflect.ts`）
 * は**反映せず人へ通知する側へ倒す**（`pickModelByJev`と同じ作り。採否を決められない指摘を
 * 通知なしで計画へ流さない）。
 */

/** 「取り込む」とみなす確率の下限。下回れば人が決める */
export const PLAN_REVIEW_ADOPT_THRESHOLD = 0.5;

const QUESTION_KEY = "adopt";

/**
 * 応答を待つ上限。Webhookの処理の中で待つため、既定（8秒）より短くする。超えたら`null`＝通知側へ倒す。
 * 長いと配信の応答が遅れ、失敗扱いの再送を招く。
 */
const PICK_TIMEOUT_MS = 5_000;

/** Jevへ渡す状態の上限文字数。レビュー本文は数千字になるため切る */
const MAX_STATE_LENGTH = 12_000;

export async function pickPlanReviewAdoptionByJev(reviewBody: string): Promise<boolean | null> {
  const response = await askSystemOne({
    feature: "plan_review_pick",
    timeoutMs: PICK_TIMEOUT_MS,
    state: reviewBody.slice(0, MAX_STATE_LENGTH),
    questions: {
      [QUESTION_KEY]: {
        type: "noul",
        instructions:
          "これは実装計画への初回レビューです。計画を直さなければ実装の成立・安全性・受け入れ条件を損なう重大な指摘が、根拠が具体的で、計画を直せば解決するものですか。" +
          "人の判断が要る方針の分かれ目や、根拠が曖昧な指摘を含むなら「いいえ」にしてください。",
      },
    },
  });
  if (!response) return null;

  const answer = readNoulAnswer(response.answers?.[QUESTION_KEY]);
  if (!answer) return null;
  return answer.noul >= PLAN_REVIEW_ADOPT_THRESHOLD;
}
