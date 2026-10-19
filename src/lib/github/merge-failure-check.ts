import { fetchCheckRollup } from "@/lib/github/check-rollup";
import { githubGraphql } from "@/lib/github/graphql";
import type { MergeFailureCheckState } from "@/lib/github/merge-failure";

/**
 * マージを拒んだ必須チェック1件の、いまの状態を取る（#4878）。マージが拒まれたときだけ呼ぶ。
 *
 * **RESTの`/commits/{sha}/check-runs`は使わない**（`check-rollup.ts`の冒頭を参照）。
 * commit status（`issue-deck/ios-precheck`など）はdescriptionまで要るので、ios-precheckと同じ
 * `status.context(name:)`で1件だけ引く。見つからなければcheck-runとして`fetchCheckRollup`の
 * `ciChecks`から名前で探す。どちらにも無ければ`missing`（そのコミットではまだ走っていない）。
 *
 * 取得に失敗したらnullを返す（説明の文言は状態が無くても出せるため、マージの応答を壊さない）。
 */
const STATUS_QUERY = `query($owner: String!, $name: String!, $expression: String!, $context: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      ... on Commit {
        status {
          context(name: $context) {
            state
            description
          }
        }
      }
    }
  }
}`;

type StatusResponse = {
  repository: {
    object: { status?: { context: { state: string; description: string | null } | null } | null } | null;
  } | null;
};

function fromStatusState(state: string): MergeFailureCheckState["state"] {
  switch (state.toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "EXPECTED":
      return "missing";
    default:
      return "pending";
  }
}

export async function fetchMergeFailureCheck(
  owner: string,
  repo: string,
  sha: string,
  checkName: string,
  token: string,
): Promise<MergeFailureCheckState | null> {
  try {
    const data = await githubGraphql<StatusResponse>(
      token,
      STATUS_QUERY,
      { owner, name: repo, expression: sha, context: checkName },
      "mergeFailureCheck",
    );
    const context = data.repository?.object?.status?.context;
    if (context) {
      return { state: fromStatusState(context.state), description: context.description || null };
    }

    const rollup = await fetchCheckRollup(owner, repo, sha, token);
    if (!rollup) return null;
    const run = rollup.ciChecks.find((check) => check.name === checkName);
    if (!run) return { state: "missing", description: null };
    if (run.status !== "completed") return { state: "pending", description: null };
    return {
      state: run.conclusion === "success" || run.conclusion === "skipped" || run.conclusion === "neutral" ? "success" : "failure",
      description: null,
    };
  } catch (error) {
    console.warn(`[fetchMergeFailureCheck] ${owner}/${repo}@${sha} ${checkName} の取得に失敗しました:`, error);
    return null;
  }
}
