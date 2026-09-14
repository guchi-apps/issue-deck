import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { claudeReviewOfContexts, type RollupContextNode } from "@/lib/github/check-rollup";
import { githubGraphql } from "@/lib/github/graphql";
import {
  isIssueBranch,
  readReviewCallerConfig,
  REVIEW_CALLER_FILE,
  REVIEW_SAMPLE_SIZE,
  reviewOutcomeOf,
  sortByRiskPathsState,
  templateRiskPatterns,
  type ReviewCallerConfig,
  type ReviewOutcomeItem,
} from "@/lib/review-gate-config";

/** 雛形の置き場所。`main`のものを正とする（配布はここから行う） */
const TEMPLATE_OWNER = "guchi-apps";
const TEMPLATE_REPOSITORY = "issue-deck";
const TEMPLATE_EXPRESSION = "main:.github/templates/callers/claude-review-develop.yml";

/** callerとPR一覧を1クエリにまとめるリポジトリ数。チェックは読まないので軽い（5件で約1.5秒） */
const REPOSITORIES_PER_QUERY = 5;

/**
 * 読むPRの件数。`issue-<番号>`以外（release・タグ配布）も混ざるため、数える件数より多めに読む。
 * 足りなければ数える件数が20件を下回るだけで、画面はその件数で出す。
 */
const PULL_REQUESTS_PER_REPOSITORY = 30;

/**
 * チェック集約を1クエリで読むPR数（#2963）。
 *
 * **GitHubのGraphQLは約10秒で打ち切られ、502・504を返す。** 所要時間はPR数にほぼ比例し
 * （issue-deckで30件約5秒・10件約1.5秒）、「5リポジトリ×30PR×チェック」を1クエリに
 * まとめていた#2948の形では毎回打ち切られて画面が500になっていた。
 */
const PULL_REQUESTS_PER_ROLLUP_QUERY = 10;

/** チェック集約のクエリを同時に投げる数。PR数の合計が多くても待ち時間を数秒に収めるため */
const ROLLUP_QUERY_CONCURRENCY = 4;

/** 1コミットあたりに読むチェック数。issue-deckのdevelop向けPRでも30件に届かない */
const CHECKS_PER_COMMIT = 60;

export type ReviewGateRepository = {
  fullName: string;
  /** callerのGitHub上のURL（読んだブランチのもの） */
  callerUrl: string;
  config: ReviewCallerConfig;
  /** 直近のIssue PR。**古い順** */
  outcomes: ReviewOutcomeItem[];
  /**
   * 実行状況を読み切れたか（#2963）。偽なら`outcomes`は欠けている（チェック集約の取得に
   * 失敗したPRがある）ため、画面は件数を出さない。
   */
  outcomesAvailable: boolean;
};

export type ReviewGateOverview = {
  repositories: ReviewGateRepository[];
  /** 雛形を取得できたか。偽ならrisk-pathsの状態は比べていない */
  templateAvailable: boolean;
};

type TargetRepository = {
  fullName: string;
  ownerLogin: string;
  name: string;
  defaultBranch: string;
};

type BlobText = { text?: string | null } | null;

type PullRequestSummary = { number: number; url: string; headRefName: string } | null;

type RepositoryEntry = {
  developCaller: BlobText;
  defaultCaller: BlobText;
  pullRequests: { nodes: PullRequestSummary[] | null } | null;
} | null;

type RollupEntry = {
  pullRequest: {
    commits: {
      nodes:
        | ({
            commit: {
              statusCheckRollup: {
                contexts: { nodes: RollupContextNode[] | null } | null;
              } | null;
            } | null;
          } | null)[]
        | null;
    } | null;
  } | null;
} | null;

/** callerを読めたリポジトリと、チェック集約を読む対象のIssue PR（新しい順） */
type CallerResult = {
  target: TargetRepository;
  callerUrl: string;
  config: ReviewCallerConfig;
  pullRequests: { number: number; url: string }[];
};

type RollupRequest = { target: TargetRepository; number: number };

/**
 * 各リポジトリのClaudeレビューの実行条件と、直近の実行状況を集める（#2948）。
 *
 * **callerは`develop`のものを読む。** `pull_request`で起動するワークフローはPRのマージ先
 * （develop）側の定義で動くため。`develop`を持たないリポジトリは既定ブランチを読む。
 *
 * **実行状況はGraphQLの`statusCheckRollup`から取る**（`check-rollup.ts`の理由と同じく、
 * RESTの`/commits/{sha}/check-runs`は無関係なワークフローのジョブまで混ざる）。
 * ワークフロー実行一覧（REST）からジョブを引く案は、リポジトリ数×実行数ぶんの往復になるため採らない。
 *
 * **取得は2段階に分ける**（#2963）。callerとPR一覧（軽い）をリポジトリ5件ずつ読んでから、
 * Issue PRのチェック集約（重い）をPR10件ずつ読む。1クエリにまとめるとGitHubの打ち切りに掛かる。
 */
export async function collectReviewGates(userId: string): Promise<ReviewGateOverview> {
  const repositories = await db.repository.findMany({
    where: {
      archived: false,
      installation: { userInstallations: { some: { userId } } },
    },
    select: {
      fullName: true,
      ownerLogin: true,
      name: true,
      defaultBranch: true,
      installation: { select: { installationId: true } },
    },
    orderBy: { fullName: "asc" },
  });

  if (repositories.length === 0) return { repositories: [], templateAvailable: false };

  // インストールごとにトークンを取り直す。1本のクエリに混ぜられるのは同じインストールのぶんだけ
  const byInstallation = new Map<number, TargetRepository[]>();
  for (const { installation, ...repository } of repositories) {
    const targets = byInstallation.get(installation.installationId) ?? [];
    targets.push(repository);
    byInstallation.set(installation.installationId, targets);
  }

  let templatePatterns: string[] | null = null;
  const results: ReviewGateRepository[] = [];

  for (const [installationId, targets] of byInstallation) {
    const token = await getInstallationToken(installationId);
    if (templatePatterns === null) templatePatterns = await fetchTemplatePatterns(token);

    const callers: CallerResult[] = [];
    for (const chunk of chunked(targets, REPOSITORIES_PER_QUERY)) {
      callers.push(...(await fetchCallers(chunk, token, templatePatterns)));
    }

    const requests = callers.flatMap(({ target, pullRequests }) =>
      pullRequests.map(({ number }) => ({ target, number })),
    );
    const { contextsByPullRequest, failedRepositories } = await fetchRollups(requests, token);

    for (const caller of callers) {
      results.push({
        fullName: caller.target.fullName,
        callerUrl: caller.callerUrl,
        config: caller.config,
        outcomes: outcomesOf(caller, contextsByPullRequest),
        outcomesAvailable: !failedRepositories.has(caller.target.fullName),
      });
    }
  }

  return {
    repositories: sortByRiskPathsState(results),
    templateAvailable: templatePatterns !== null,
  };
}

/** 雛形のrisk-pathsを読む。取れなければnull（状態を比べずに出す） */
async function fetchTemplatePatterns(token: string): Promise<string[] | null> {
  try {
    const data = await githubGraphql<{ repository: { object: BlobText } | null }>(
      token,
      `query($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) { object(expression: $expression) { ... on Blob { text } } }
}`,
      { owner: TEMPLATE_OWNER, name: TEMPLATE_REPOSITORY, expression: TEMPLATE_EXPRESSION },
      "Claudeレビューの雛形取得",
    );
    const text = data.repository?.object?.text;
    if (typeof text !== "string") return null;
    const patterns = templateRiskPatterns(text);
    return patterns.length > 0 ? patterns : null;
  } catch (error) {
    console.warn(`[review-gates] 雛形を取得できませんでした: ${String(error)}`);
    return null;
  }
}

/** callerとPR一覧を読む。callerを持たないリポジトリ（docsなど）は返さない */
async function fetchCallers(
  targets: TargetRepository[],
  token: string,
  templatePatterns: string[] | null,
): Promise<CallerResult[]> {
  const declarations = targets
    .map((_, i) => `$owner${i}: String!, $name${i}: String!, $develop${i}: String!, $default${i}: String!`)
    .join(", ");
  const selections = targets
    .map(
      (_, i) => `  r${i}: repository(owner: $owner${i}, name: $name${i}) {
    developCaller: object(expression: $develop${i}) { ... on Blob { text } }
    defaultCaller: object(expression: $default${i}) { ... on Blob { text } }
    pullRequests(baseRefName: "develop", first: ${PULL_REQUESTS_PER_REPOSITORY}, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number url headRefName }
    }
  }`,
    )
    .join("\n");

  const variables: Record<string, unknown> = {};
  targets.forEach((target, i) => {
    variables[`owner${i}`] = target.ownerLogin;
    variables[`name${i}`] = target.name;
    variables[`develop${i}`] = `develop:.github/workflows/${REVIEW_CALLER_FILE}`;
    variables[`default${i}`] = `${target.defaultBranch}:.github/workflows/${REVIEW_CALLER_FILE}`;
  });

  const data = await githubGraphql<Record<string, RepositoryEntry>>(
    token,
    `query(${declarations}) {\n${selections}\n}`,
    variables,
    "Claudeレビューの実行条件の取得",
    // 1リポジトリが読めなくても（削除済み・developが無いなど）残りは表示する
    { allowPartialData: true },
  );

  const results: CallerResult[] = [];
  targets.forEach((target, i) => {
    const entry = data[`r${i}`];
    const developText = entry?.developCaller?.text;
    const branch = typeof developText === "string" ? "develop" : target.defaultBranch;
    const source = typeof developText === "string" ? developText : entry?.defaultCaller?.text;
    if (typeof source !== "string") return;

    const config = readReviewCallerConfig(source, templatePatterns);
    if (!config) return;

    const pullRequests = (entry?.pullRequests?.nodes ?? [])
      .filter((node): node is NonNullable<PullRequestSummary> => !!node && isIssueBranch(node.headRefName))
      .map(({ number, url }) => ({ number, url }));

    results.push({
      target,
      callerUrl: `https://github.com/${target.fullName}/blob/${branch}/.github/workflows/${REVIEW_CALLER_FILE}`,
      config,
      pullRequests,
    });
  });
  return results;
}

/**
 * Issue PRのheadコミットのチェック集約を、PR10件ずつ並行して読む。
 *
 * **1クエリの失敗で画面全体を500にしない**（#2963）。失敗したクエリは1回だけ投げ直し、
 * それでも取れなければ含まれていたリポジトリを`failedRepositories`に入れ、画面にはその行の
 * 実行状況を出さない。投げ直すのは、並行して投げているときに単独なら2秒で返るクエリが
 * 一時的に落ちることがあったため。
 */
async function fetchRollups(
  requests: RollupRequest[],
  token: string,
): Promise<{ contextsByPullRequest: Map<string, RollupContextNode[]>; failedRepositories: Set<string> }> {
  const contextsByPullRequest = new Map<string, RollupContextNode[]>();
  const failedRepositories = new Set<string>();

  const chunks = chunked(requests, PULL_REQUESTS_PER_ROLLUP_QUERY);
  await forEachWithConcurrency(chunks, ROLLUP_QUERY_CONCURRENCY, async (chunk) => {
    const data = await fetchRollupChunk(chunk, token).catch((error: unknown) => {
      console.warn(`[review-gates] チェック集約を取得できませんでした。投げ直します: ${String(error)}`);
      return fetchRollupChunk(chunk, token).catch((retryError: unknown) => {
        console.warn(`[review-gates] チェック集約を取得できませんでした: ${String(retryError)}`);
        return null;
      });
    });
    if (!data) {
      for (const request of chunk) failedRepositories.add(request.target.fullName);
      return;
    }
    chunk.forEach((request, i) => {
      const contexts =
        data[`p${i}`]?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
      contextsByPullRequest.set(pullRequestKey(request.target, request.number), contexts);
    });
  });

  return { contextsByPullRequest, failedRepositories };
}

function fetchRollupChunk(chunk: RollupRequest[], token: string): Promise<Record<string, RollupEntry>> {
  const declarations = chunk.map((_, i) => `$owner${i}: String!, $name${i}: String!, $number${i}: Int!`).join(", ");
  const selections = chunk
    .map(
      (_, i) => `  p${i}: repository(owner: $owner${i}, name: $name${i}) {
    pullRequest(number: $number${i}) {
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${CHECKS_PER_COMMIT}) {
        nodes { __typename ... on CheckRun { name detailsUrl status conclusion checkSuite { workflowRun { workflow { resourcePath } } } } }
      } } } } }
    }
  }`,
    )
    .join("\n");

  const variables: Record<string, unknown> = {};
  chunk.forEach((request, i) => {
    variables[`owner${i}`] = request.target.ownerLogin;
    variables[`name${i}`] = request.target.name;
    variables[`number${i}`] = request.number;
  });

  return githubGraphql<Record<string, RollupEntry>>(
    token,
    `query(${declarations}) {\n${selections}\n}`,
    variables,
    "Claudeレビューの実行状況の取得",
    // PR一覧を読んだ直後に削除・移管されたPRがあっても、残りは数える
    { allowPartialData: true },
  );
}

/** 新しい順のIssue PRから、結果を最大20件、古い順で返す */
function outcomesOf(caller: CallerResult, contextsByPullRequest: Map<string, RollupContextNode[]>): ReviewOutcomeItem[] {
  const items: ReviewOutcomeItem[] = [];
  for (const pullRequest of caller.pullRequests) {
    const contexts = contextsByPullRequest.get(pullRequestKey(caller.target, pullRequest.number));
    if (!contexts) continue;
    const { aiReview, riskCheckFailed } = claudeReviewOfContexts(contexts);
    const outcome = reviewOutcomeOf(aiReview.state, riskCheckFailed);
    if (!outcome) continue;
    items.push({ number: pullRequest.number, url: pullRequest.url, outcome });
    if (items.length >= REVIEW_SAMPLE_SIZE) break;
  }
  return items.reverse();
}

function pullRequestKey(target: TargetRepository, number: number): string {
  return `${target.fullName}#${number}`;
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
