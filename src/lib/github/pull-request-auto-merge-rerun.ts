import { fetchWorkflowRunJobs, fetchWorkflowRunsForHead, rerunWorkflowJob } from "@/lib/github/actions-api";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { isAutoMergeJobName } from "@/lib/dispatch/pr-review";
import { decideReviewRerun, type ReviewRerunDecision } from "@/lib/pull-request-review-rerun";
import type { CiRerunRun } from "@/lib/pull-request-ci-rerun";

/**
 * 現在のHEADのAIレビューrunを引く（#5158・#5326）。`decideReviewRerun`へそのまま渡せる形にする。
 */
export async function fetchReviewRunsForHead(
  owner: string,
  repo: string,
  headSha: string,
  token: string,
): Promise<CiRerunRun[]> {
  return (await fetchWorkflowRunsForHead(owner, repo, headSha, token)).map((run) => ({
    id: run.id,
    name: run.name,
    path: run.path,
    status: run.status ?? "unknown",
    conclusion: run.conclusion,
    headSha: run.head_sha,
    event: run.event,
    htmlUrl: run.html_url,
  }));
}

type RejectCode = Extract<ReviewRerunDecision, { action: "reject" }>["code"];

export type AutoMergeRerunOutcome =
  | { ok: true; runId: number; jobId: number }
  | { ok: false; code: RejectCode | "no_auto_merge_job" };

/**
 * 現在のHEADのAIレビューrunのうち、**`auto-merge`ジョブだけ**を再実行する（#5326）。
 *
 * 使うのは2か所で、どちらも「判定を下し直す」のではなく「止まっていた判定をもう一度通す」ため。
 *
 * - 停滞の引き上げが付けた`00.check-user`を、セッションが動き出したので外したとき。PRが先に
 *   作られていると`auto-merge`は「確認待ち」で見送ったまま終わっており、ラベルを外しても
 *   走り直す契機が無い（#5322・#5324）
 * - 予約（`gh pr merge --auto`）したのにGitHubがマージを起こさないまま止まったPR（#5287）
 *
 * **判定はワークフローの`auto-merge`が持ったまま。** 再実行されたジョブはラベル・Codexの結果・
 * 保留の判定を読み直してから、マージするか予約するかを決める（`resumePrReviewMerge`と同じ部品。#3990）。
 * 他のジョブ（リスク判定・Claudeレビュー）は取得済みの出力を引き継ぐので走り直さない。
 *
 * 対象のrunの選び方は`decideReviewRerun`（openなdevelop向けPR・HEAD一致・完了済みの最新run）。
 * 実行中のrunがあれば、そのrunの`auto-merge`がこれから現在のラベルを読むので何もしない。
 * PRやrunの取得、再実行のGitHub APIの失敗は例外のまま投げる。
 */
export async function rerunPullRequestAutoMerge(params: {
  owner: string;
  repo: string;
  number: number;
  /** 呼び出し側が見たHEAD。省略時は取得した現在のHEADを使う */
  headSha?: string;
  token: string;
}): Promise<AutoMergeRerunOutcome> {
  const { owner, repo, number, token } = params;
  const current = await fetchPullRequest(owner, repo, number, token);
  const runs = await fetchReviewRunsForHead(owner, repo, current.head.sha, token);
  const decision = decideReviewRerun(
    { state: current.state, merged: current.merged, baseRef: current.base.ref, headSha: current.head.sha },
    params.headSha ?? current.head.sha,
    runs,
  );
  if (decision.action === "reject") return { ok: false, code: decision.code };

  const jobs = await fetchWorkflowRunJobs(owner, repo, decision.runId, token);
  const autoMerge = jobs.find((job) => isAutoMergeJobName(job.name));
  if (!autoMerge?.id) return { ok: false, code: "no_auto_merge_job" };
  await rerunWorkflowJob(owner, repo, autoMerge.id, token);
  return { ok: true, runId: decision.runId, jobId: autoMerge.id };
}
