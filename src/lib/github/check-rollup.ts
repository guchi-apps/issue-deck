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

/** `statusCheckRollup`の中身。ref経由・PR経由のどちらのクエリでも同じ形を引く */
const ROLLUP_FIELDS = `
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
`;

const QUERY = `
  query($owner: String!, $name: String!, $expression: String!) {
    repository(owner: $owner, name: $name) {
      object(expression: $expression) {
        ... on Commit {
          statusCheckRollup {
            ${ROLLUP_FIELDS}
          }
        }
      }
    }
  }
`;

/**
 * PR番号で引く版（#1742）。**CI状態とコンフリクト有無を1回のクエリでまとめて取る**ためにある。
 *
 * `mergeable`はRESTだとPRの単体取得でしか返らないため、PR一覧で出そうとするとPR1件につき
 * 1回APIが増える。GraphQLの`PullRequest`は`mergeable`と（headコミットの）`statusCheckRollup`を
 * 同じ1クエリで返せるので、いま消費しているCI状態の1回に相乗りさせられる。
 *
 * `commits(last: 1)`が返すのはPRのheadコミットで、ref経由で`head.sha`を指定した場合と同じもの。
 */
const PULL_REQUEST_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        mergeable
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                ${ROLLUP_FIELDS}
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

/** `statusCheckRollup`のノード。ref経由・PR経由で同じ形を受ける */
type RollupNode = {
  state: string | null;
  contexts: { totalCount: number; nodes: RollupContextNode[] };
};

type RollupResponse = {
  repository: {
    object: {
      statusCheckRollup: RollupNode | null;
    } | null;
  } | null;
};

type PullRequestRollupResponse = {
  repository: {
    pullRequest: {
      /** `MERGEABLE` / `CONFLICTING` / `UNKNOWN`（GitHubが判定中） */
      mergeable: string | null;
      commits: { nodes: { commit: { statusCheckRollup: RollupNode | null } | null }[] };
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
 * GraphQLの`statusCheckRollup`ノードを`CheckRollup`へ写す。
 * ノードがnull（＝refは解決できたがチェックが1件も無い）の場合は空の一覧を返す。
 */
function toCheckRollup(rollup: RollupNode | null | undefined): CheckRollup {
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

  return toCheckRollup(data.repository?.object?.statusCheckRollup);
}

/** PR1件ぶんのチェック集約とコンフリクト有無（#1742） */
export type PullRequestRollup = {
  /** headコミットのチェック集約。取得できなければnull */
  rollup: CheckRollup | null;
  /**
   * コンフリクトの有無。`true`＝マージ可能・`false`＝コンフリクトあり・
   * `null`＝GitHubが判定中（`UNKNOWN`）または取得できなかった。
   */
  mergeable: boolean | null;
};

/** GraphQLの`MergeableState`をbooleanへ写す。`UNKNOWN`（判定中）はnullのまま扱う */
function toMergeable(state: string | null | undefined): boolean | null {
  if (state === "MERGEABLE") return true;
  if (state === "CONFLICTING") return false;
  return null;
}

/**
 * PR番号で、headコミットのチェック集約とコンフリクト有無を**1回のクエリで**取得する（#1742）。
 *
 * PR一覧はもともとCI状態のためにPR1件につきGraphQLを1回消費している。`mergeable`をここへ
 * 相乗りさせることで、一覧でもコンフリクトを出せるようにしつつGitHub APIの消費は増やさない
 * （RESTの単体取得を足すとPR1件につき1回増える）。
 *
 * 取得に失敗しても例外にせず`{ rollup: null, mergeable: null }`へ縮退させる
 * （`fetchCheckRollup`と同じ扱い。CI状態やコンフリクトが取れないだけで一覧を落とさない）。
 */
export async function fetchPullRequestRollup(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<PullRequestRollup> {
  const data = await githubGraphql<PullRequestRollupResponse>(
    token,
    PULL_REQUEST_QUERY,
    { owner, name: repo, number },
    "pullRequestStatusCheckRollup",
    { permissionHint: "（Pull requests: ReadとChecks: Readの権限が要ります）" },
  ).catch((error: unknown) => {
    console.warn(`[fetchPullRequestRollup] ${owner}/${repo}#${number} の取得に失敗しました:`, error);
    return null;
  });

  const pullRequest = data?.repository?.pullRequest;
  if (!pullRequest) return { rollup: null, mergeable: null };

  return {
    rollup: toCheckRollup(pullRequest.commits.nodes[0]?.commit?.statusCheckRollup),
    mergeable: toMergeable(pullRequest.mergeable),
  };
}
