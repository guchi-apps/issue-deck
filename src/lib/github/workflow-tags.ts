import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/github-api-error";
import { githubGraphql } from "@/lib/github/graphql";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  evaluateWorkflowTags,
  extractWorkflowTagRef,
  latestWorkflowTag,
  type WorkflowTagRef,
  type WorkflowTagStatus,
} from "@/lib/workflow-tags";

/**
 * 各リポジトリが参照している共有ワークフローのタグを集めて、issue-deck 側の最新タグと
 * 突き合わせる（#985）。
 *
 * **なぜ要るか。** 共有ワークフローは `uses:` のタグ固定で配っており、issue-deck 側を
 * 直しても各リポジトリの caller を上げるまで反映されない。**上げ忘れても何も起きないので
 * 気づけない。** 実際 `workflows/v10` は car-care だけに配られ、他9リポジトリは v9 のまま
 * 数時間放置されていた（#1147 の修正が届いていない状態）。
 *
 * **取得はGraphQLでまとめて行う（#1503）。** 元はRESTで「`.github/workflows/`の一覧」＋
 * 「ファイルごとの内容」を順に読んでおり、リポジトリあたり 1 + ワークフロー数、実測で
 * 141リクエスト・42秒かかっていた。画面を開くたびにこれだけ待たされるうえ、その42秒の
 * どこかで1回でも失敗すればパネル全体が「取得に失敗しました」になる（本番では 503 になった）。
 * GraphQLはTreeのentriesからBlobの`text`まで1往復で取れるため、同じ情報が
 * **クエリ数本・数秒**で揃う。RESTのレート制限も消費しない（GraphQLは別枠）。
 */

/** 共有ワークフローのタグを探す先。issue-deck 自身のリポジトリ */
const SOURCE_REPOSITORY = "guchi-apps/issue-deck";

/** 1度に取るタグ数。`workflows/v*` は多くないため1ページで足りる想定 */
const TAG_PAGE_SIZE = 100;

/**
 * 1本のGraphQLクエリに載せるリポジトリ数。
 *
 * 1本にまとめるほど往復は減るが、クエリが長くなるほどGitHub側の実行時間も伸びる。
 * 15リポジトリを1本で投げても約3秒で返ることは確認済みで、余裕を見てこの値にしている。
 */
const REPOSITORIES_PER_QUERY = 10;

export type WorkflowTagOverview = {
  /** issue-deck 側の最新タグ。取得に失敗した場合は null */
  latest: string | null;
  repositories: WorkflowTagStatus[];
};

/** GraphQLで読む対象リポジトリ（DBから引いた行のうち、問い合わせに要る項目だけ） */
type TargetRepository = {
  fullName: string;
  ownerLogin: string;
  name: string;
  defaultBranch: string;
};

/** `.github/workflows/` 直下のエントリ（Treeのentries） */
type TreeEntry = {
  name: string;
  type: string;
  object: { text?: string | null } | null;
};

/** エイリアス1つぶんの応答。ディレクトリが無ければ `object` が null になる */
type RepositoryTree = { object: { entries?: TreeEntry[] | null } | null } | null;

/**
 * issue-deck のタグ一覧から最新の `workflows/vN` を取る。
 *
 * **タグ名の昇順だと `workflows/v9` が `workflows/v10` より後ろに来る**ため、
 * 100件で切れたときに新しいタグを取りこぼさないようタグの日付降順で取る
 * （どれが最新かの判定自体は `latestWorkflowTag` が版数で行う）。
 */
async function fetchLatestTag(token: string): Promise<string | null> {
  const [owner, name] = SOURCE_REPOSITORY.split("/");
  const query = `query($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      refs(
        refPrefix: "refs/tags/"
        query: "workflows/"
        first: $first
        orderBy: { field: TAG_COMMIT_DATE, direction: DESC }
      ) {
        nodes { name }
      }
    }
  }`;

  type Data = { repository: { refs: { nodes: { name: string }[] } | null } | null };
  try {
    const data = await githubGraphql<Data>(
      token,
      query,
      { owner, name, first: TAG_PAGE_SIZE },
      "共有ワークフローの最新タグ取得",
    );
    return latestWorkflowTag((data.repository?.refs?.nodes ?? []).map((node) => node.name));
  } catch (error) {
    // 最新タグが分からなくても一覧自体は出す。latest が null なら「古い」判定を行わないため、
    // 誤って全リポジトリを更新対象として表示してしまうことはない
    console.warn(`[workflow-tags] 最新タグを取得できませんでした: ${String(error)}`);
    return null;
  }
}

/**
 * 複数リポジトリの caller を1本のGraphQLクエリでまとめて読む。
 *
 * リポジトリごとにエイリアス（`r0`・`r1`…）を並べ、`.github/workflows` のTreeから
 * 各Blobの`text`まで一度に取る。**共有ワークフローを参照していないファイル
 * （`ci.yml`・`deploy.yml` 等）も本文を見ないと判別できない**が、GraphQLなら
 * 追加の往復無しでまとめて返るため、RESTのようにファイル数ぶん往復せずに済む。
 */
async function fetchRefsBatch(
  targets: TargetRepository[],
  token: string,
): Promise<Map<string, WorkflowTagRef[]>> {
  const declarations = targets
    .map((_, index) => `$owner${index}: String!, $name${index}: String!, $expression${index}: String!`)
    .join(", ");
  const selections = targets
    .map(
      (_, index) => `  r${index}: repository(owner: $owner${index}, name: $name${index}) {
    object(expression: $expression${index}) {
      ... on Tree { entries { name type object { ... on Blob { text } } } }
    }
  }`,
    )
    .join("\n");

  const variables: Record<string, unknown> = {};
  targets.forEach((target, index) => {
    variables[`owner${index}`] = target.ownerLogin;
    variables[`name${index}`] = target.name;
    variables[`expression${index}`] = `${target.defaultBranch}:.github/workflows`;
  });

  const data = await githubGraphql<Record<string, RepositoryTree>>(
    token,
    `query(${declarations}) {\n${selections}\n}`,
    variables,
    "共有ワークフローの参照タグ取得",
    // 1リポジトリが読めなくても（DBに残っている削除済みリポジトリなど）残りは表示する
    { allowPartialData: true },
  );

  const refsByRepository = new Map<string, WorkflowTagRef[]>();
  targets.forEach((target, index) => {
    const entries = data[`r${index}`]?.object?.entries ?? [];
    const refs: WorkflowTagRef[] = [];
    for (const entry of entries) {
      if (entry.type !== "blob" || !entry.name.endsWith(".yml")) continue;
      // バイナリや巨大ファイルでは text が null になる。ワークフローYAMLでは起こらない想定
      if (typeof entry.object?.text !== "string") continue;

      const ref = extractWorkflowTagRef(entry.name, entry.object.text);
      if (ref) refs.push(ref);
    }
    refsByRepository.set(target.fullName, refs);
  });
  return refsByRepository;
}

/**
 * 対象リポジトリすべての参照状況を集める。
 *
 * 対象は**マルチエージェント対応かつアーカイブ済みでない**リポジトリ（既存の再同期と同じ条件）。
 * issue-deck 自身はローカルパス参照（`uses: ./.github/workflows/...`）でタグを持たないため、
 * 参照が見つからず結果に現れない。
 */
export async function collectWorkflowTags(userId: string): Promise<WorkflowTagOverview> {
  const repositories = await db.repository.findMany({
    where: {
      hasClaudeWorkflow: true,
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

  if (repositories.length === 0) return { latest: null, repositories: [] };

  // インストールごとにトークンを取り直す。1ユーザーが複数インストールを持つことがある
  const tokens = new Map<number, string>();
  const tokenFor = async (installationId: number): Promise<string> => {
    const cached = tokens.get(installationId);
    if (cached) return cached;
    const token = await getInstallationToken(installationId);
    tokens.set(installationId, token);
    return token;
  };

  const firstToken = await tokenFor(repositories[0]!.installation.installationId);
  const latest = await fetchLatestTag(firstToken);

  // トークンはインストール単位なので、1本のクエリに混ぜられるのは同じインストールのぶんだけ
  const byInstallation = new Map<number, TargetRepository[]>();
  for (const repository of repositories) {
    const installationId = repository.installation.installationId;
    const targets = byInstallation.get(installationId) ?? [];
    targets.push(repository);
    byInstallation.set(installationId, targets);
  }

  const refsByRepository = new Map<string, WorkflowTagRef[]>();
  for (const [installationId, targets] of byInstallation) {
    const token = await tokenFor(installationId);
    for (let start = 0; start < targets.length; start += REPOSITORIES_PER_QUERY) {
      const chunk = targets.slice(start, start + REPOSITORIES_PER_QUERY);
      const refs = await fetchRefsBatch(chunk, token);
      for (const [fullName, value] of refs) refsByRepository.set(fullName, value);
    }
  }

  const statuses: WorkflowTagStatus[] = [];
  for (const repository of repositories) {
    const refs = refsByRepository.get(repository.fullName) ?? [];
    // 共有ワークフローを参照していないリポジトリは表示しても意味がないため落とす
    if (refs.length === 0) continue;
    statuses.push(evaluateWorkflowTags(repository.fullName, refs, latest));
  }

  return { latest, repositories: statuses };
}

/** タグ更新PRを一括作成するワークフロー（issue-deck 側） */
const PROPAGATE_WORKFLOW_FILE = "propagate-workflow-tag.yml";

/**
 * 更新が必要なリポジトリへ、タグを上げるPRを作るワークフローを起動する（#1173）。
 *
 * **対象はここ（DBを持つissue-deck側）で決めて渡す。** ワークフロー側で再検知すると、
 * 画面に出ている一覧と実際の対象がずれる。
 *
 * 起動するだけで、PRの作成自体はActions側が行う。ローカルのチェックアウトに依存せず、
 * 同じ処理を手動起動でも使えるようにするため。
 */
export async function dispatchPropagation(
  userId: string,
): Promise<{ dispatched: boolean; tag: string | null; repositories: string[] }> {
  const overview = await collectWorkflowTags(userId);
  if (!overview.latest) return { dispatched: false, tag: null, repositories: [] };

  const targets = overview.repositories
    .filter((status) => status.outdated || status.mismatched)
    .map((status) => status.fullName);

  // 対象が無いのに起動すると、何もしないrunが履歴に残って紛らわしい
  if (targets.length === 0) {
    return { dispatched: false, tag: overview.latest, repositories: [] };
  }

  const [owner, repo] = SOURCE_REPOSITORY.split("/");
  const source = await db.repository.findFirst({
    where: { fullName: SOURCE_REPOSITORY },
    select: { installation: { select: { installationId: true } } },
  });
  if (!source) {
    throw new Error(`${SOURCE_REPOSITORY} が同期されていません`);
  }

  const token = await getInstallationToken(source.installation.installationId);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${PROPAGATE_WORKFLOW_FILE}/dispatches`;
  const res = await githubFetch(url, token, {
    method: "POST",
    body: {
      ref: "main",
      inputs: { tag: overview.latest, repositories: JSON.stringify(targets) },
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }

  return { dispatched: true, tag: overview.latest, repositories: targets };
}
