import {
  convertPullRequestToDraft,
  markPullRequestReadyForReview,
  rerunWorkflowRun,
} from "@/lib/github/actions-api";
import { GithubApiError } from "@/lib/github/issues-api";
import { fetchReviewRunsForHead } from "@/lib/github/pull-request-auto-merge-rerun";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { decideReviewRerun, decideReviewRestart, isWorkflowRunRetryRefused } from "@/lib/pull-request-review-rerun";

/** 下書きからレビュー可能へ戻す試行。失敗するとPRが下書きのまま残るので、一時的な失敗は吸収する */
const READY_ATTEMPTS = 3;
const READY_RETRY_DELAY_MS = 500;

export type ReviewRerunOutcome =
  | { ok: true; method: "rerun"; runId: number }
  | { ok: true; method: "restart" }
  /** `rejected`は操作の前に断った（PRは動かしていない）。`failed`はGitHub側の操作が失敗した */
  | { ok: false; kind: "rejected" | "failed"; code: string };

/**
 * 再実行を断られたrunの代わりに、下書き→レビュー可能の往復で`ready_for_review`のrunを起こす（#5212）。
 * 下書きへ戻す前のPRの判定は`decideReviewRestart`。
 */
async function restartReviewViaDraft(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  token: string,
): Promise<ReviewRerunOutcome> {
  const latest = await fetchPullRequest(owner, repo, number, token);
  const decision = decideReviewRestart(
    {
      state: latest.state,
      merged: latest.merged,
      draft: latest.draft,
      baseRef: latest.base.ref,
      headSha: latest.head.sha,
      nodeId: latest.node_id,
    },
    headSha,
  );
  if (decision.action === "reject") return { ok: false, kind: "rejected", code: decision.code };

  try {
    await convertPullRequestToDraft(decision.nodeId, token);
  } catch (error) {
    console.error(`[review-rerun] ${owner}/${repo}#${number} 下書きへ戻せません:`, error);
    return { ok: false, kind: "failed", code: "restart_failed" };
  }

  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, READY_RETRY_DELAY_MS * attempt));
    try {
      await markPullRequestReadyForReview(decision.nodeId, token);
      return { ok: true, method: "restart" };
    } catch (error) {
      console.error(`[review-rerun] ${owner}/${repo}#${number} レビュー可能へ戻せません:`, error);
    }
  }
  return { ok: false, kind: "failed", code: "ready_failed" };
}

/**
 * 現在のHEADのAIレビューをやり直す（#5158・#5212）。画面の「AIレビューを再実行」と、取り残しの巡回
 * （`pull-request-review-stall-rescue.ts`。#5215）が同じ手順を通る。判定は`decideReviewRerun`。
 *
 * 判定や操作の結果は戻り値で返す。PRやrunの取得など、それ以外のGitHub APIの失敗は例外のまま投げる。
 */
export async function rerunPullRequestReview(params: {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  token: string;
}): Promise<ReviewRerunOutcome> {
  const { owner, repo, number, headSha, token } = params;
  const current = await fetchPullRequest(owner, repo, number, token);
  const runs = await fetchReviewRunsForHead(owner, repo, current.head.sha, token);
  const decision = decideReviewRerun(
    { state: current.state, merged: current.merged, baseRef: current.base.ref, headSha: current.head.sha },
    headSha,
    runs,
  );
  if (decision.action === "reject") return { ok: false, kind: "rejected", code: decision.code };
  try {
    await rerunWorkflowRun(owner, repo, decision.runId, false, token);
  } catch (error) {
    if (error instanceof GithubApiError && isWorkflowRunRetryRefused(error.status, error.message)) {
      return await restartReviewViaDraft(owner, repo, number, headSha, token);
    }
    throw error;
  }
  return { ok: true, method: "rerun", runId: decision.runId };
}
