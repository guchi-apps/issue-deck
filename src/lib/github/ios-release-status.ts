import { fetchWorkflowRunJobs } from "@/lib/github/actions-api";
import { recordGithubApiCall } from "@/lib/github/api-usage";
import { GithubApiError } from "@/lib/github/github-api-error";
import { fetchTagRefs } from "@/lib/github/release-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  IOS_TESTFLIGHT_TAG_PREFIX,
  IOS_TESTFLIGHT_WORKFLOW_FILE,
  iosDeliveryForReleases,
  iosFailuresForReleases,
  judgeIosRun,
  summarizeIosStages,
} from "@/lib/ios-testflight-status";
import type { IosReleaseStatus } from "@/lib/release-history";

/**
 * リリース履歴のiOS配布バッジの材料（#3800・#3867・#3993）を1リポジトリぶん取る（#5214）。
 *
 * run一覧は1回約1MB・約3秒と、リリース履歴の取得で最も重い。条件付きGETでも304が返るまで約2秒かかる
 * ので、一覧の応答からは切り離し、`api/repositories/release-history/ios-status`で後から重ねる。
 *
 * **`githubFetchJsonWithEtag`を使わない。** あちらは応答全体をキャッシュするので、1MBの本文が
 * リポジトリの数だけヒープに残る（本番は`--max-old-space-size=256`）。ここでは必要な項目だけを覚える。
 */

type IosTestflightRun = {
  id: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  runAttempt: number;
};

/** 失敗段階を覚える上限。対象は失敗したrunだけなので、通常はここまで増えない */
const FAILED_STAGE_MEMO_LIMIT = 200;

const runsMemo = new Map<string, { etag: string; runs: IosTestflightRun[] }>();
const failedStageMemo = new Map<string, string | null>();

/** テストから覚えた値を捨てる */
export function clearIosReleaseStatusMemo(): void {
  runsMemo.clear();
  failedStageMemo.clear();
}

/**
 * リリースのコミットと照合するiOS配布runを新しい順に取る。ワークフロー未導入（404）は空配列にする。
 * **それ以外の失敗は例外にする。** 空配列へ縮退すると、全部の版に「iOS自動配布なし」が付いてしまう。
 */
async function fetchIosTestflightRuns(owner: string, repo: string, token: string): Promise<IosTestflightRun[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${IOS_TESTFLIGHT_WORKFLOW_FILE}/runs?per_page=100`;
  const memo = runsMemo.get(url);
  const res = await githubFetch(url, token, {
    record: false,
    headers: memo ? { "If-None-Match": memo.etag } : undefined,
  });
  if (res.status === 304 && memo) return memo.runs;
  // 304はレート制限を消費しないので、それ以外だけを使用量に載せる（`conditional-request.ts`と同じ）
  recordGithubApiCall(url);
  if (res.status === 404) return [];
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const body: {
    workflow_runs?: Array<{
      id?: number;
      head_sha?: string;
      status?: string;
      conclusion?: string | null;
      run_attempt?: number;
    }>;
  } = await res.json();
  const runs = (body.workflow_runs ?? []).flatMap((run) =>
    typeof run.id === "number" && typeof run.head_sha === "string" && typeof run.status === "string"
      ? [
          {
            id: run.id,
            headSha: run.head_sha,
            status: run.status,
            conclusion: run.conclusion ?? null,
            runAttempt: run.run_attempt ?? 1,
          },
        ]
      : [],
  );
  const etag = res.headers.get("etag");
  if (etag) runsMemo.set(url, { etag, runs });
  return runs;
}

/**
 * 失敗したrunの段階名。完了したrunの試行は結果が変わらないので、取れた値は`runId`と試行回数で覚える。
 * ジョブを読めなかったときは覚えず、段階なしの失敗として返す（次回取り直す）。
 */
async function fetchFailedStage(owner: string, repo: string, run: IosTestflightRun, token: string): Promise<string | null> {
  const key = `${owner}/${repo} ${run.id} ${run.runAttempt}`;
  const memoized = failedStageMemo.get(key);
  if (memoized !== undefined) return memoized;
  try {
    const jobs = await fetchWorkflowRunJobs(owner, repo, run.id, token);
    const verdict = judgeIosRun(run, summarizeIosStages(jobs));
    const stage = verdict.kind === "failed" ? verdict.failedStage : null;
    if (failedStageMemo.size >= FAILED_STAGE_MEMO_LIMIT) {
      failedStageMemo.delete(failedStageMemo.keys().next().value as string);
    }
    failedStageMemo.set(key, stage);
    return stage;
  } catch {
    return null;
  }
}

/** 指定した版（リリース履歴に載せたRelease）のiOS配布の状況を取る */
export async function fetchIosReleaseStatus(
  owner: string,
  repo: string,
  token: string,
  releaseTagNames: readonly string[],
): Promise<IosReleaseStatus> {
  const [versionRefs, deliveredRefs, iosRuns] = await Promise.all([
    fetchTagRefs(owner, repo, token, "v"),
    fetchTagRefs(owner, repo, token, IOS_TESTFLIGHT_TAG_PREFIX),
    fetchIosTestflightRuns(owner, repo, token),
  ]);
  const delivered = iosDeliveryForReleases(releaseTagNames, versionRefs, deliveredRefs);
  const tagNames = new Set(releaseTagNames);
  const releaseShas = new Set(
    versionRefs.filter((ref) => tagNames.has(ref.ref.replace(/^refs\/tags\//, ""))).map((ref) => ref.sha),
  );
  // run一覧は新しい順。リリースごとの最新runが失敗しているときだけ、段階名を取る。
  const latestRunsBySha = new Map<string, IosTestflightRun>();
  for (const run of iosRuns) {
    if (run.status === "completed" && !latestRunsBySha.has(run.headSha) && releaseShas.has(run.headSha)) {
      latestRunsBySha.set(run.headSha, run);
    }
  }
  const failureStages = await Promise.all(
    [...latestRunsBySha.values()].map(async (run) => {
      if (["success", "neutral", "skipped", null].includes(run.conclusion)) return { ...run, failedStage: null };
      return { ...run, failedStage: await fetchFailedStage(owner, repo, run, token) };
    }),
  );
  const failures = iosFailuresForReleases(releaseTagNames, versionRefs, failureStages);
  return {
    repoFullName: `${owner}/${repo}`,
    delivered: Object.fromEntries(delivered),
    failed: Object.fromEntries(failures),
    // runのhead_shaは版のコミットと一致しないため、版とは突き合わせず、
    // 配布が実行中のリポジトリでは途中の版を誤って「自動配布なし」と示さない。
    hasActiveRun: iosRuns.some((run) => run.status !== "completed"),
  };
}
