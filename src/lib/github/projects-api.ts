import { GithubApiError } from "@/lib/github/github-api-error";
import { githubFetch, GITHUB_API } from "@/lib/github/request";

/**
 * GitHub Projects v2（カンバン）との境界。Projects v2はGraphQLのみで、RESTは提供されていない。
 *
 * 進捗状態をProject Statusで管理する設計の詳細は docs/organization-migration.md と #991 を参照。
 * Organization所有のProjectであることが前提で、GitHub Appのorganization permission
 * `Projects: Read and write` が要る（Userアカウント所有のProjectはAppトークンでは扱えない）。
 */

/** Projectアイテム1件の解決結果。どのIssueがどのStatusかを表す */
export type ProjectItemSnapshot = {
  /** ProjectV2Item の node ID。Statusを更新する際の対象指定に使う */
  itemId: string;
  /** 対象Issueのリポジトリの数値ID（RESTのrepository.idと同じ値） */
  repositoryDatabaseId: number;
  /** 対象Issueの番号 */
  issueNumber: number;
  /** Statusフィールドの選択肢名（例: "Implementation"）。未設定ならnull */
  status: string | null;
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: { message: string }[];
};

/**
 * GraphQLを実行する。`issues-api.ts`の`deleteIssue`・`transferIssue`と同じ流儀で、
 * HTTPレベルの失敗とGraphQLの`errors`の両方をGithubApiErrorへ寄せる。
 * HTTP 200でも`errors`があれば失敗として扱うのがGraphQLの仕様。
 */
async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  operationLabel: string,
): Promise<T> {
  const res = await githubFetch(`${GITHUB_API}/graphql`, token, {
    method: "POST",
    body: { query, variables },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub GraphQL request failed: ${res.status} ${detail}`);
  }

  const json: GraphqlResponse<T> = await res.json();
  if (json.errors?.length || !json.data) {
    const message = json.errors?.map((error) => error.message).join("; ") ?? "unknown error";
    // 権限不足はここに出るため、原因を切り分けやすいようヒントを添える
    const hint = message.includes("Resource not accessible by integration")
      ? "（GitHub Appのorganization permission「Projects: Read and write」が必要です）"
      : "";
    throw new GithubApiError(403, `GitHub GraphQL ${operationLabel} failed: ${message}${hint}`);
  }
  return json.data;
}

const ITEM_FIELDS = `
  id
  content {
    ... on Issue {
      number
      repository { databaseId }
    }
  }
  fieldValueByName(name: "Status") {
    ... on ProjectV2ItemFieldSingleSelectValue { name }
  }
`;

type RawItem = {
  id: string;
  content: { number?: number; repository?: { databaseId?: number } } | null;
  fieldValueByName: { name?: string } | null;
};

/**
 * Issue以外（PR・DraftIssue）や、content解決前のアイテムはnullを返す。
 * Projectには方針上Issueのみを入れるが、手動でPRを追加されても落ちないようにしておく。
 */
function toSnapshot(raw: RawItem | null | undefined): ProjectItemSnapshot | null {
  if (!raw) return null;
  const issueNumber = raw.content?.number;
  const repositoryDatabaseId = raw.content?.repository?.databaseId;
  if (issueNumber === undefined || repositoryDatabaseId === undefined) return null;
  return {
    itemId: raw.id,
    repositoryDatabaseId,
    issueNumber,
    status: raw.fieldValueByName?.name ?? null,
  };
}

/**
 * ProjectV2Itemのnode IDから、対象Issueと現在のStatusを1クエリで解決する。
 *
 * Webhook（projects_v2_item）のペイロードは`content_node_id`しか持たず、DBが持つ
 * `githubIssueId`（RESTの数値ID）と直接突き合わせられないため、どのみちnodeの解決が要る。
 * ついでに現在のStatusも取得することで、`changes`を持たないaction（created・restored等）でも
 * 同じ経路で扱えるようにしている。ペイロードの形にも依存しない。
 */
export async function fetchProjectItem(
  itemNodeId: string,
  token: string,
): Promise<ProjectItemSnapshot | null> {
  const data = await graphql<{ node: RawItem | null }>(
    token,
    `query($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${ITEM_FIELDS} } } }`,
    { id: itemNodeId },
    "fetchProjectItem",
  );
  return toSnapshot(data.node);
}

/** 1回のクエリで取得するアイテム数。GraphQLのconnectionは最大100 */
const ITEMS_PAGE_SIZE = 100;

/**
 * Projectの全アイテムをページングで取得する。再同期時のバックフィルに使う。
 * Issue以外のアイテムは除外して返す。
 */
export async function fetchProjectItems(
  owner: string,
  projectNumber: number,
  token: string,
): Promise<ProjectItemSnapshot[]> {
  const snapshots: ProjectItemSnapshot[] = [];
  let cursor: string | null = null;

  for (;;) {
    const data: {
      organization: {
        projectV2: {
          items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawItem[] };
        } | null;
      } | null;
    } = await graphql(
      token,
      `query($owner: String!, $number: Int!, $first: Int!, $after: String) {
        organization(login: $owner) {
          projectV2(number: $number) {
            items(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { ${ITEM_FIELDS} }
            }
          }
        }
      }`,
      { owner, number: projectNumber, first: ITEMS_PAGE_SIZE, after: cursor },
      "fetchProjectItems",
    );

    const items = data.organization?.projectV2?.items;
    if (!items) return snapshots;

    for (const node of items.nodes) {
      const snapshot = toSnapshot(node);
      if (snapshot) snapshots.push(snapshot);
    }

    if (!items.pageInfo.hasNextPage) return snapshots;
    cursor = items.pageInfo.endCursor;
  }
}

/** StatusフィールドのidとProject自身のid。Statusの書き込みに必要な識別子一式 */
export type ProjectStatusField = {
  /** ProjectV2 の node ID */
  projectId: string;
  /** Statusフィールド（単一選択）の node ID */
  fieldId: string;
  /** 選択肢名 -> 選択肢id */
  optionIdByName: Map<string, string>;
};

/**
 * Statusフィールドのidと選択肢idを取得する。
 *
 * **これらのidはProjectごとに異なる**ため環境変数では持てず、実行時に引く必要がある
 * （`PROJECT_V2_OWNER`・`PROJECT_V2_NUMBER`から辿る）。値自体は選択肢を編集しない限り
 * 変わらないため、呼び出し側（`report-progress.ts`）で短時間キャッシュしている。
 */
export async function fetchProjectStatusField(
  owner: string,
  projectNumber: number,
  token: string,
): Promise<ProjectStatusField | null> {
  const data = await graphql<{
    organization: {
      projectV2: {
        id: string;
        field: { id?: string; options?: { id: string; name: string }[] } | null;
      } | null;
    } | null;
  }>(
    token,
    `query($owner: String!, $number: Int!) {
      organization(login: $owner) {
        projectV2(number: $number) {
          id
          field(name: "Status") {
            ... on ProjectV2SingleSelectField { id options { id name } }
          }
        }
      }
    }`,
    { owner, number: projectNumber },
    "fetchProjectStatusField",
  );

  const project = data.organization?.projectV2;
  const field = project?.field;
  // Statusフィールドが単一選択でない・存在しない場合はfieldのフラグメントが一致せず空になる
  if (!project || !field?.id || !field.options) return null;

  return {
    projectId: project.id,
    fieldId: field.id,
    optionIdByName: new Map(field.options.map((option) => [option.name, option.id])),
  };
}

/** 1つのIssueが同時に所属しうるProjectの数。実運用では1件だが余裕を持って引く */
const ISSUE_PROJECT_ITEMS_PAGE_SIZE = 20;

/**
 * Issueから、指定したProjectにおけるアイテムを引く。Projectに未登録ならnull。
 *
 * DBの`Issue.projectItemId`（Phase 1でWebhook・再同期が入れる）を使わずGitHubへ問い合わせるのは、
 * **報告APIの正しさをDBの鮮度に依存させないため**。Projectへ追加された直後でWebhookが未到達でも
 * 正しく更新できる。逆にProjectへ自動追加はしない（Project WorkflowsのAuto-addに任せる）。
 */
export async function findProjectItemForIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  projectId: string,
  token: string,
): Promise<ProjectItemSnapshot | null> {
  const data = await graphql<{
    repository: {
      issue: {
        projectItems: { nodes: (RawItem & { project: { id: string } })[] };
      } | null;
    } | null;
  }>(
    token,
    `query($owner: String!, $repo: String!, $number: Int!, $first: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          projectItems(first: $first) {
            nodes { project { id } ${ITEM_FIELDS} }
          }
        }
      }
    }`,
    { owner, repo, number: issueNumber, first: ISSUE_PROJECT_ITEMS_PAGE_SIZE },
    "findProjectItemForIssue",
  );

  const node = data.repository?.issue?.projectItems.nodes.find(
    (item) => item.project.id === projectId,
  );
  return toSnapshot(node);
}

/**
 * ProjectアイテムのStatusを更新する。
 *
 * この関数がProjects側への唯一の書き込み口で、呼ぶのはissue-deckのGitHub Appトークンのみ。
 * 各リポジトリのワークフローやローカル実行へProjects v2の書き込み権限を配らないための一本化
 * （設計は docs/progress-status-architecture.md「中核の判断」）。
 */
export async function updateProjectItemStatus(
  params: { projectId: string; itemId: string; fieldId: string; optionId: string },
  token: string,
): Promise<void> {
  await graphql(
    token,
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`,
    params,
    "updateProjectItemStatus",
  );
}
