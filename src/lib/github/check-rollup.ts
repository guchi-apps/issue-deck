import { githubGraphql } from "@/lib/github/graphql";

/**
 * コミットの「GitHubがPRのChecksとして数えるチェック」を取得する（#1578）。
 *
 * **RESTの`/commits/{sha}/check-runs`を使ってはいけない。** あれはそのSHAに紐づくチェックを
 * 分け隔てなく返すため、`issues`・`issue_comment`・`workflow_dispatch`・`workflow_run`・
 * `schedule`で起動したワークフローのジョブまで混ざる。issue-deckの`develop`は無人実行の
 * ワークフローが常時走っているため、リリースPR（headが`develop`そのもの）のheadコミットには
 * 実測で**58件のワークフロー実行・218件のcheck-run**がぶら下がっており、そのうちGitHubが
 * PRのChecksとして数えるのは`pull_request`・`push`で起動した**5件のワークフロー実行・27件**
 * だけだった。残りをそのまま集約すると、無関係な自動化のキャンセル1件で「CI失敗」、実行中1件で
 * 「CI実行中」になり、GitHubの画面では成功・マージ可能なのにissue-deckだけが失敗を出す。
 *
 * GraphQLの`Commit.statusCheckRollup`は**GitHubの画面が出しているものそのもの**で、この
 * 選別を自前で再現しなくてよい（起動イベントで絞る自作フィルタは、GitHub Actions以外の
 * チェック——外部CIのcommit status——を落としてしまう）。
 */

/** チェック1件。RESTのcheck-runと同じ語彙（小文字）へ正規化したもの */
export type RollupCheck = { status: string; conclusion: string | null };

export type CheckRollup = {
  /**
   * GitHub自身の集約結果（小文字。`success` / `pending` / `failure` / `error` / `expected`）。
   * チェックが1件も無ければnull。
   */
  state: string | null;
  /**
   * チェック1件ずつ。`CONTEXTS_PAGE_SIZE`を超える場合だけnullで、そのときは`state`だけで判断する
   * （ページングを重ねるより、GitHubの集約値をそのまま使う方が問い合わせ1回で済み、ずれも生まない）。
   */
  checks: RollupCheck[] | null;
};

/** 1回のクエリで引くチェックの上限。GraphQLの`first`の上限値でもある */
const CONTEXTS_PAGE_SIZE = 100;

const QUERY = `
  query($owner: String!, $name: String!, $expression: String!) {
    repository(owner: $owner, name: $name) {
      object(expression: $expression) {
        ... on Commit {
          statusCheckRollup {
            state
            contexts(first: ${CONTEXTS_PAGE_SIZE}) {
              totalCount
              nodes {
                __typename
                ... on CheckRun {
                  status
                  conclusion
                }
                ... on StatusContext {
                  state
                }
              }
            }
          }
        }
      }
    }
  }
`;

type RollupContextNode = {
  __typename?: string;
  /** CheckRun。`QUEUED` / `IN_PROGRESS` / `COMPLETED`など */
  status?: string | null;
  /** CheckRun。`SUCCESS` / `FAILURE` / `CANCELLED` / `SKIPPED`など */
  conclusion?: string | null;
  /** StatusContext（外部CIのcommit status）。`SUCCESS` / `PENDING` / `FAILURE`など */
  state?: string | null;
};

type RollupResponse = {
  repository: {
    object: {
      statusCheckRollup: {
        state: string | null;
        contexts: { totalCount: number; nodes: RollupContextNode[] };
      } | null;
    } | null;
  } | null;
};

/**
 * commit status（StatusContext）を、check-runと同じ`status`/`conclusion`の形へ寄せる。
 * `PENDING`・`EXPECTED`は完了していない扱いにして、check-runの実行中と同じ経路で判定させる。
 */
function fromStatusContext(state: string): RollupCheck {
  const normalized = state.toLowerCase();
  if (normalized === "pending" || normalized === "expected") {
    return { status: normalized, conclusion: null };
  }
  return {
    status: "completed",
    conclusion: normalized === "success" ? "success" : "failure",
  };
}

function toRollupCheck(node: RollupContextNode): RollupCheck | null {
  if (node.__typename === "CheckRun") {
    return {
      status: (node.status ?? "").toLowerCase(),
      conclusion: node.conclusion ? node.conclusion.toLowerCase() : null,
    };
  }
  if (node.__typename === "StatusContext" && node.state) {
    return fromStatusContext(node.state);
  }
  return null;
}

/**
 * 指定ref（ブランチ名・タグ・SHA）のチェック集約を取得する。取得できなければnull
 * （呼び出し側で`unknown`へ縮退させる。CI状態が取れないだけでマージの導線を消さないため）。
 */
export async function fetchCheckRollup(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<CheckRollup | null> {
  const data = await githubGraphql<RollupResponse>(
    token,
    QUERY,
    { owner, name: repo, expression: ref },
    "statusCheckRollup",
    { permissionHint: "（Checks: Readの権限が要ります）" },
  ).catch((error: unknown) => {
    // 取れないと画面のCI状態が一律`unknown`になる。原因が分かるようログには残す。
    console.warn(`[fetchCheckRollup] ${owner}/${repo}@${ref} の取得に失敗しました:`, error);
    return null;
  });
  if (!data) return null;

  const rollup = data.repository?.object?.statusCheckRollup;
  // refは解決できたがチェックが1件も無い場合、`statusCheckRollup`はnullになる。
  if (!rollup) return { state: null, checks: [] };

  const state = rollup.state ? rollup.state.toLowerCase() : null;
  if (rollup.contexts.totalCount > CONTEXTS_PAGE_SIZE) {
    return { state, checks: null };
  }
  return {
    state,
    checks: rollup.contexts.nodes
      .map(toRollupCheck)
      .filter((check): check is RollupCheck => check !== null),
  };
}
