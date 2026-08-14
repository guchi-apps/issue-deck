import { githubGraphql } from "@/lib/github/graphql";

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
  /** 対象Issueがopenかどうか。Statusで絞って一覧するとき、closed分を落とすのに使う */
  issueOpen: boolean;
  /** Statusフィールドの選択肢名（例: "Implementation"）。未設定ならnull */
  status: string | null;
};

/** 権限不足だったときにメッセージへ添えるヒント。Projects v2はorganization permissionを要求する */
const PROJECTS_PERMISSION_HINT =
  "（GitHub Appのorganization permission「Projects: Read and write」が必要です）";

/** GraphQLを実行する。共通処理は`graphql.ts`にあり、ここでは権限ヒントだけを固定する */
function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  operationLabel: string,
): Promise<T> {
  return githubGraphql<T>(token, query, variables, operationLabel, {
    permissionHint: PROJECTS_PERMISSION_HINT,
  });
}

const ITEM_FIELDS = `
  id
  content {
    ... on Issue {
      number
      state
      repository { databaseId }
    }
  }
  fieldValueByName(name: "Status") {
    ... on ProjectV2ItemFieldSingleSelectValue { name }
  }
`;

type RawItem = {
  id: string;
  content: { number?: number; state?: string; repository?: { databaseId?: number } } | null;
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
    issueOpen: raw.content?.state === "OPEN",
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

/** Issueと、指定したProjectにおけるそのアイテムの状態 */
export type IssueProjectState = {
  /** IssueのGraphQL node ID。Projectへ追加する際の`contentId`に使う */
  issueNodeId: string;
  /**
   * Issueがopenかどうか。closedなIssueの進捗を巻き戻さないための判定に使う（#1348）。
   * `item`が無い（盤面へ未登録）場合でも判断できるよう、アイテム側ではなくIssue側から取る。
   */
  issueOpen: boolean;
  /** 指定したProjectにおけるアイテム。未登録ならnull */
  item: ProjectItemSnapshot | null;
};

/**
 * Issueのnode IDと、指定したProjectにおけるアイテムを1クエリで引く。Issueが無ければnull。
 *
 * DBの`Issue.projectItemId`（Phase 1でWebhook・再同期が入れる）を使わずGitHubへ問い合わせるのは、
 * **報告APIの正しさをDBの鮮度に依存させないため**。Projectへ追加された直後でWebhookが未到達でも
 * 正しく更新できる。
 *
 * 未登録だった場合にそのまま`addProjectItem`へ渡せるよう、Issueのnode IDも一緒に取っている
 * （追加のための問い合わせを増やさないため。#1036）。
 */
export async function findIssueProjectState(
  owner: string,
  repo: string,
  issueNumber: number,
  projectId: string,
  token: string,
): Promise<IssueProjectState | null> {
  const data = await graphql<{
    repository: {
      issue: {
        id: string;
        state: string;
        projectItems: { nodes: (RawItem & { project: { id: string } })[] };
      } | null;
    } | null;
  }>(
    token,
    `query($owner: String!, $repo: String!, $number: Int!, $first: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          id
          state
          projectItems(first: $first) {
            nodes { project { id } ${ITEM_FIELDS} }
          }
        }
      }
    }`,
    { owner, repo, number: issueNumber, first: ISSUE_PROJECT_ITEMS_PAGE_SIZE },
    "findIssueProjectState",
  );

  const issue = data.repository?.issue;
  if (!issue) return null;

  const node = issue.projectItems.nodes.find((item) => item.project.id === projectId);
  return { issueNodeId: issue.id, issueOpen: issue.state === "OPEN", item: toSnapshot(node) };
}

/**
 * IssueをProjectへ追加し、追加後のアイテムを返す。
 *
 * **Project WorkflowsのAuto-addには頼れない。** GitHub Freeでは1リポジトリ、Teamでも5リポジトリ
 * までしか自動追加を設定できず（1ワークフローにつき1リポジトリ）、対象リポジトリ全体を載せる
 * という#991の目標に届かない。Projectへの読み書きをissue-deckへ一本化する設計に、アイテムの
 * 追加も含める（#1036）。
 *
 * `addProjectV2ItemById`は**登録済みなら既存のアイテムを返す**ため、重複追加にはならない。
 */
export async function addProjectItem(
  projectId: string,
  contentId: string,
  token: string,
): Promise<ProjectItemSnapshot | null> {
  const data = await graphql<{ addProjectV2ItemById: { item: RawItem | null } | null }>(
    token,
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { ${ITEM_FIELDS} }
      }
    }`,
    { projectId, contentId },
    "addProjectItem",
  );
  return toSnapshot(data.addProjectV2ItemById?.item);
}

/** 1回のクエリで取得するIssue数 */
const OPEN_ISSUES_PAGE_SIZE = 100;

/** 盤面への一括投入で扱うIssueの上限。1リポジトリぶんの再同期が延々と続かないようにする */
const OPEN_ISSUES_MAX = 500;

/**
 * リポジトリのopenなIssueのnode IDと番号を取得する。再同期時の一括投入に使う。
 *
 * DBは`githubIssueId`（RESTの数値ID）しか持たず`addProjectV2ItemById`の`contentId`に使えないため、
 * GraphQLから引く。上限に達した場合は打ち切る（次回の再同期で続きが載る）。
 */
export async function fetchOpenIssueNodes(
  owner: string,
  repo: string,
  token: string,
): Promise<{ number: number; nodeId: string }[]> {
  const issues: { number: number; nodeId: string }[] = [];
  let cursor: string | null = null;

  for (;;) {
    const data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: { id: string; number: number }[];
        };
      } | null;
    } = await graphql(
      token,
      `query($owner: String!, $repo: String!, $first: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          issues(states: OPEN, first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id number }
          }
        }
      }`,
      { owner, repo, first: OPEN_ISSUES_PAGE_SIZE, after: cursor },
      "fetchOpenIssueNodes",
    );

    const page = data.repository?.issues;
    if (!page) return issues;

    for (const node of page.nodes) {
      issues.push({ number: node.number, nodeId: node.id });
    }

    if (!page.pageInfo.hasNextPage || issues.length >= OPEN_ISSUES_MAX) return issues;
    cursor = page.pageInfo.endCursor;
  }
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
