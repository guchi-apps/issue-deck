import { formatTimeOfDay } from "@/lib/format-date-time";
import { callClaudeMessages, type AiApiError } from "@/lib/claude/request";
import {
  buildRecommendationPrompt,
  parseRecommendationResponse,
  type RecommendationTarget,
  type ReleaseReviewRecommendation,
} from "@/lib/release-review-recommendation";

/**
 * 全体レビューの指摘ごとのAIの推奨判断と理由案（#4676）を作る。**返すのは提案まで**で、
 * 判断の保存はユーザーが確定したときに判断APIが行う（他のAI下書き生成と同じ立場）。
 */

/** 画面の表示中に呼ぶため、待ち続けない */
const RECOMMEND_TIMEOUT_MS = 90_000;

type AnthropicMessageResponse = { content?: { type: string; text?: string }[]; model?: string };

export type GeneratedRecommendations = {
  model: string | null;
  /** 指摘IDごとの推奨。読めなかった指摘は入らない */
  byFinding: Map<string, Omit<ReleaseReviewRecommendation, "id" | "findingId" | "baseSha" | "headSha" | "createdAt">>;
};

/** 画面にそのまま出る失敗理由。429は利用枠の上限なので、再取得できる時刻を添える */
export function recommendationFailureMessage(status: number, error: AiApiError | null): string {
  if (status !== 429) return `AIの推奨を作れませんでした (${status})`;
  const at = error?.retryAt ? formatTimeOfDay(error.retryAt) : null;
  return at
    ? `AIの利用枠が上限に達しています。${at}ごろ以降に再取得できます`
    : "AIの利用枠が上限に達しています。しばらく待ってから再取得してください";
}

export async function generateReleaseReviewRecommendations(
  token: string,
  input: { repoFullName: string; prNumber: number; findings: readonly RecommendationTarget[] },
): Promise<GeneratedRecommendations> {
  const { response, json, error } = await callClaudeMessages<AnthropicMessageResponse>({
    feature: "release_review_recommend",
    token,
    timeoutMs: RECOMMEND_TIMEOUT_MS,
    body: {
      max_tokens: 1200 * input.findings.length + 400,
      messages: [{ role: "user", content: buildRecommendationPrompt(input) }],
    },
  });
  if (!response.ok) throw new Error(recommendationFailureMessage(response.status, error));
  const text = json?.content?.find((block) => block.type === "text")?.text ?? "";
  return {
    model: json?.model ?? null,
    byFinding: parseRecommendationResponse(
      text,
      input.findings.map((f) => f.id),
    ),
  };
}
