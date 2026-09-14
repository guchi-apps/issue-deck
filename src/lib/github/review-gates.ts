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

/** 1クエリにまとめるリポジトリ数。PR×チェックの入れ子で重いため、タグ照会（10件）より絞る */
const REPOSITORIES_PER_QUERY = 5;

/**
 * 読むPRの件数。`issue-<番号>`以外（release・タグ配布）も混ざるため、数える件数より多めに読む。
 * 足りなければ数える件数が20件を下回るだけで、画面はその件数で出す。
 */
const PULL_REQUESTS_PER_REPOSITORY = 30;

/** 1コミットあたりに読むチェック数。issue-deckのdevelop向けPRでも30件に届かない */
const CHECKS_PER_COMMIT = 60;

export type ReviewGateRepository = {
  fullName: string;
  /** callerのGitHub上のURL（読んだブランチのもの） */
  callerUrl: string;
  config: ReviewCallerConfig;
  /** 直近のIssue PR。**古い順** */
  outcomes: ReviewOutcomeItem[];
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

type PullRequestNode = {
  number: number;
  url: string;
  headRefName: string;
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

type RepositoryEntry = {
  developCaller: BlobText;
  defaultCaller: BlobText;
  pullRequests: { nodes: PullRequestNode[] | null } | null;
} | null;

/**
 * 各リポジトリのClaudeレビューの実行条件と、直近の実行状況を集める（#2948）。
 *
 * **callerは`develop`のものを読む。** `pull_request`で起動するワークフローはPRのマージ先
 * （develop）側の定義で動くため。`develop`を持たないリポジトリは既定ブランチを読む。
 *
 * **実行状況はGraphQLの`statusCheckRollup`から取る**（`check-rollup.ts`の理由と同じく、
 * RESTの`/commits/{sha}/check-runs`は無関係なワークフローのジョブまで混ざる）。
 * ワークフロー実行一覧（REST）からジョブを引く案は、リポジトリ数×実行数ぶんの往復になるため採らない。
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

    for (let start = 0; start < targets.length; start += REPOSITORIES_PER_QUERY) {
      const chunk = targets.slice(start, start + REPOSITORIES_PER_QUERY);
      results.push(...(await fetchBatch(chunk, token, templatePatterns)));
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

async function fetchBatch(
  targets: TargetRepository[],
  token: string,
  templatePatterns: string[] | null,
): Promise<ReviewGateRepository[]> {
  const declarations = targets
    .map((_, i) => `$owner${i}: String!, $name${i}: String!, $develop${i}: String!, $default${i}: String!`)
    .join(", ");
  const selections = targets
    .map(
      (_, i) => `  r${i}: repository(owner: $owner${i}, name: $name${i}) {
    developCaller: object(expression: $develop${i}) { ... on Blob { text } }
    defaultCaller: object(expression: $default${i}) { ... on Blob { text } }
    pullRequests(baseRefName: "develop", first: ${PULL_REQUESTS_PER_REPOSITORY}, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number url headRefName
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${CHECKS_PER_COMMIT}) {
          nodes { __typename ... on CheckRun { name detailsUrl status conclusion checkSuite { workflowRun { workflow { resourcePath } } } } }
        } } } } }
      }
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

  const results: ReviewGateRepository[] = [];
  targets.forEach((target, i) => {
    const entry = data[`r${i}`];
    const developText = entry?.developCaller?.text;
    const branch = typeof developText === "string" ? "develop" : target.defaultBranch;
    const source = typeof developText === "string" ? developText : entry?.defaultCaller?.text;
    // callerを持たないリポジトリ（docsなど）は出さない
    if (typeof source !== "string") return;

    const config = readReviewCallerConfig(source, templatePatterns);
    if (!config) return;

    results.push({
      fullName: target.fullName,
      callerUrl: `https://github.com/${target.fullName}/blob/${branch}/.github/workflows/${REVIEW_CALLER_FILE}`,
      config,
      outcomes: outcomesOf(entry?.pullRequests?.nodes ?? []),
    });
  });
  return results;
}

/** 新しい順のPRから、Issue PRの結果を最大20件、古い順で返す */
function outcomesOf(nodes: PullRequestNode[]): ReviewOutcomeItem[] {
  const items: ReviewOutcomeItem[] = [];
  for (const node of nodes) {
    if (!node || !isIssueBranch(node.headRefName)) continue;
    const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    const { aiReview, riskCheckFailed } = claudeReviewOfContexts(contexts);
    const outcome = reviewOutcomeOf(aiReview.state, riskCheckFailed);
    if (!outcome) continue;
    items.push({ number: node.number, url: node.url, outcome });
    if (items.length >= REVIEW_SAMPLE_SIZE) break;
  }
  return items.reverse();
}
