import { dropSupersededCheckRuns, type RollupContextNode } from "@/lib/github/check-rollup";
import { githubGraphql } from "@/lib/github/graphql";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * マージ先ブランチで必須になっているチェックのうち、PRのheadでまだ成功していないもの（#4884）。
 *
 * yoteiflow#1284では、CI・コード・競合がすべて緑なのに、ルールセットで必須の
 * commit status（`issue-deck/ios-precheck`）が待機中でGitHubが`mergeable_state: blocked`を
 * 返していた。CI状態（`ciState`）はios-precheckを集約から外している（`check-rollup.ts`）ため、
 * PR詳細は「マージ可能」と出し、押すと405で拒否されていた。
 *
 * **引くのは`mergeable_state`が`blocked`のPR詳細だけ**（REST2回＋GraphQL1回が増える）。
 * 必須チェックの名前はルールセット（`/rules/branches/{branch}`）とブランチ保護
 * （`/branches/{branch}`の`protection`）の両方から集める。どちらかしか使っていないリポジトリが
 * あるため。読めなければnullを返し、代表状態は従来どおりにする（推測で止めない）。
 */
export type RequiredCheckState = "pending" | "failure" | "missing";

export type UnmetRequiredCheck = {
  name: string;
  state: RequiredCheckState;
  /** commit statusのdescription（「iOS修復待ち」など）。check-run・未実行ならnull */
  description: string | null;
};

type RuleResponse = { type?: string; parameters?: { required_status_checks?: { context?: string }[] } }[];

type BranchResponse = {
  protection?: {
    required_status_checks?: { contexts?: string[]; checks?: { context?: string }[] } | null;
  } | null;
};

const QUERY = `query($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                name
                status
                conclusion
                startedAt
                completedAt
                checkSuite { workflowRun { workflow { resourcePath } } }
              }
              ... on StatusContext {
                context
                state
                description
              }
            }
          }
        }
      }
    }
  }
}`;

type ContextNode = RollupContextNode & { description?: string | null };

type QueryResponse = {
  repository: {
    object: { statusCheckRollup?: { contexts: { nodes: ContextNode[] } } | null } | null;
  } | null;
};

/** ルールセットとブランチ保護の応答から、必須チェック名を重複なしで取り出す */
export function requiredCheckNamesOf(rules: RuleResponse | null, branch: BranchResponse | null): string[] {
  const names = new Set<string>();
  for (const rule of rules ?? []) {
    if (rule.type !== "required_status_checks") continue;
    for (const check of rule.parameters?.required_status_checks ?? []) {
      if (check.context) names.add(check.context);
    }
  }
  const protection = branch?.protection?.required_status_checks;
  for (const context of protection?.contexts ?? []) names.add(context);
  for (const check of protection?.checks ?? []) {
    if (check.context) names.add(check.context);
  }
  return [...names];
}

const SUCCESS_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * 必須チェック名と、headコミットのチェック一覧から、成功していないものを返す。
 * 同じ名前のcheck-runが走り直していれば古い実行は外す（`dropSupersededCheckRuns`）。
 */
export function unmetRequiredChecks(requiredNames: string[], nodes: ContextNode[]): UnmetRequiredCheck[] {
  const current = dropSupersededCheckRuns(nodes) as ContextNode[];
  const unmet: UnmetRequiredCheck[] = [];
  for (const name of requiredNames) {
    const status = current.find((node) => node.__typename === "StatusContext" && node.context === name);
    if (status) {
      const state = (status.state ?? "").toUpperCase();
      if (state === "SUCCESS") continue;
      unmet.push({
        name,
        state: state === "FAILURE" || state === "ERROR" ? "failure" : "pending",
        description: status.description || null,
      });
      continue;
    }
    const runs = current.filter((node) => node.__typename === "CheckRun" && node.name === name);
    if (runs.length === 0) {
      unmet.push({ name, state: "missing", description: null });
      continue;
    }
    if (runs.some((run) => (run.status ?? "").toUpperCase() !== "COMPLETED")) {
      unmet.push({ name, state: "pending", description: null });
      continue;
    }
    if (runs.some((run) => !SUCCESS_CONCLUSIONS.has((run.conclusion ?? "").toUpperCase()))) {
      unmet.push({ name, state: "failure", description: null });
    }
  }
  return unmet;
}

async function fetchJson<T>(url: string, token: string): Promise<T | null> {
  const res = await githubFetch(url, token);
  // 404はルール・保護が無いブランチ。必須チェック無しとして扱う
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${url}`);
  return (await res.json()) as T;
}

export async function fetchUnmetRequiredChecks(
  owner: string,
  repo: string,
  baseRef: string,
  sha: string,
  token: string,
): Promise<UnmetRequiredCheck[] | null> {
  try {
    const branch = encodeURIComponent(baseRef);
    const [rules, protection] = await Promise.all([
      fetchJson<RuleResponse>(`${GITHUB_API}/repos/${owner}/${repo}/rules/branches/${branch}`, token),
      fetchJson<BranchResponse>(`${GITHUB_API}/repos/${owner}/${repo}/branches/${branch}`, token),
    ]);
    const names = requiredCheckNamesOf(rules, protection);
    if (names.length === 0) return [];
    const data = await githubGraphql<QueryResponse>(
      token,
      QUERY,
      { owner, name: repo, expression: sha },
      "unmetRequiredChecks",
    );
    return unmetRequiredChecks(names, data.repository?.object?.statusCheckRollup?.contexts.nodes ?? []);
  } catch (error) {
    console.warn(`[fetchUnmetRequiredChecks] ${owner}/${repo}@${sha} の取得に失敗しました:`, error);
    return null;
  }
}
