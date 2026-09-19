/**
 * 共通知識（`guchi-apps/docs`）とフリート全体の知見メモを取ってくる（#2912）。**サーバー専用。**
 *
 * 取るものは2つで、材料も掘り方も別なのでクエリを分けている。
 *
 * 1. `guchi-apps/docs`の`knowledge/`配下のMarkdown本文。**採用済みの共通知識**にあたる
 * 2. フリート各リポジトリのIssueに残った知見メモ（`<!-- knowledge-candidate -->`）と、
 *    それに対する格上げ判定（`<!-- knowledge-promotion:judged -->`）のコメント
 *
 * 2は`guchi-apps/docs`の`promote-knowledge.yml`が毎日巡回しているのと同じ材料を、同じ検索語で
 * 引いている。**判定はここでは行わない**（判定エージェントの仕事）。整形は`lib/knowledge-board.ts`
 * が持ち、ここは取ってきた形をそのまま返す。
 *
 * **トークンはユーザー本人のもの**を使う（`vps-inventory-api.ts`・`ideas-api.ts`と同じ）。
 * `guchi-apps/docs`はprivateで、Organizationを横断する検索も要るため。
 */

import { githubGraphql } from "@/lib/github/graphql";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  isKnowledgeFilePath,
  type RawIssue,
  type RawKnowledgeFile,
  type RawPromotionFile,
  type RawPromotionPullRequest,
} from "@/lib/knowledge-board";
import { PROMOTION_BRANCH_PREFIX } from "@/lib/knowledge-promotion-pr";

const DOCS_OWNER = "guchi-apps";
const DOCS_REPO = "docs";

/** 格上げ判定の反映先ディレクトリ。ここだけを「採用済みの知見」として数える */
const KNOWLEDGE_DIR = "knowledge";

/** 知見メモを探す検索語。`promote-knowledge.yml`が使っているものと同じにしてある */
const MEMO_SEARCH_QUERY = `org:${DOCS_OWNER} knowledge-candidate sort:updated-desc`;

/** 1ページあたりのIssue数（GraphQLの`search`の上限） */
const ISSUES_PER_PAGE = 100;

/**
 * めくるページ数の上限。
 *
 * 2026-09-08時点で検索は585件ヒットするが、その大半は**本文にマーカーの文字列が出てくるだけ**の
 * Issue（この仕組みを設計したもの・プロンプトを直したもの）で、実際に知見メモを持つのは
 * 先頭100件のうち73件だった。全件を舐めると6ページ・実測30秒近くかかるため、更新の新しい順に
 * 3ページで打ち切り、**打ち切ったことは`truncated`で返す**（黙って切ると「全部見た」と読める）。
 */
const MAX_PAGES = 3;

/**
 * 1Issueあたり読むコメント数（末尾から）。
 *
 * 知見メモも判定結果も**実装が終わったあとに投稿される**ので、末尾から見れば足りる。
 */
const COMMENTS_PER_ISSUE = 30;

const KNOWLEDGE_FILES_QUERY = `
query KnowledgeFiles($owner: String!, $repo: String!, $expression: String!) {
  repository(owner: $owner, name: $repo) {
    url
    object(expression: $expression) {
      ... on Tree {
        entries {
          name
          type
          object { ... on Blob { isTruncated text } }
        }
      }
    }
  }
}`;

type KnowledgeFilesResponse = {
  repository: {
    url: string;
    object: {
      entries?: {
        name: string;
        type: string;
        object?: { isTruncated?: boolean; text?: string | null } | null;
      }[];
    } | null;
  } | null;
};

export type KnowledgeFilesResult = {
  files: RawKnowledgeFile[];
  docsRepoUrl: string;
};

/**
 * `guchi-apps/docs`の`knowledge/`を、Markdownの本文まで1リクエストで取る。
 *
 * **読めなかったときは例外にせず空で返す**（`ideas-api.ts`と同じ方針）。共有知識リポジトリを
 * 読めないだけで、候補の一覧まで出せなくなる理由が無い。
 */
export async function fetchKnowledgeFiles(token: string): Promise<KnowledgeFilesResult> {
  const fallback: KnowledgeFilesResult = {
    files: [],
    docsRepoUrl: `https://github.com/${DOCS_OWNER}/${DOCS_REPO}`,
  };

  let data: KnowledgeFilesResponse;
  try {
    data = await githubGraphql<KnowledgeFilesResponse>(
      token,
      KNOWLEDGE_FILES_QUERY,
      { owner: DOCS_OWNER, repo: DOCS_REPO, expression: `HEAD:${KNOWLEDGE_DIR}` },
      "fetchKnowledgeFiles",
      { permissionHint: "（共有知識リポジトリを読む権限が要ります）" },
    );
  } catch (error) {
    console.error("[fetchKnowledgeFiles]", error);
    return fallback;
  }

  const entries = data.repository?.object?.entries ?? [];
  const files = entries
    // README.mdは索引であって知見ではない（`##`見出しが索引の節になってしまう）。反映PRの変更一覧と
    // 同じ`isKnowledgeFilePath`で除く
    .filter((entry) => entry.type === "blob" && isKnowledgeFilePath(`${KNOWLEDGE_DIR}/${entry.name}`))
    .filter((entry) => typeof entry.object?.text === "string" && !entry.object.isTruncated)
    .map((entry) => ({ path: `${KNOWLEDGE_DIR}/${entry.name}`, text: entry.object!.text! }));

  return { files, docsRepoUrl: data.repository?.url ?? fallback.docsRepoUrl };
}

/** 反映PRを見るぶんには十分な件数。溜まっていても数件〜十数件止まりの想定（#126の見送り仕様） */
const OPEN_PULL_REQUESTS_TO_SCAN = 30;

/** 反映PR1件あたり、本文まで読む`knowledge/*.md`の上限。超えたぶんは行数だけの表示に落とす */
const KNOWLEDGE_FILES_TO_READ = 40;

const OPEN_PULL_REQUESTS_QUERY = `
query KnowledgeOpenPullRequests($owner: String!, $repo: String!, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: $first, orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes {
        number
        title
        url
        createdAt
        headRefName
        body
        baseRefOid
        headRefOid
        commits(first: 1) { nodes { commit { parents(first: 1) { nodes { oid } } } } }
        files(first: 100) { nodes { path changeType additions deletions } }
      }
    }
  }
}`;

type ChangedFile = { path: string; changeType: string; additions: number; deletions: number };

type OpenPullRequestNode = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  headRefName: string;
  body: string;
  baseRefOid: string;
  headRefOid: string;
  commits: { nodes: { commit: { parents: { nodes: { oid: string }[] } } }[] };
  files: { nodes: ChangedFile[] } | null;
};

type OpenPullRequestsResponse = {
  repository: { pullRequests: { nodes: OpenPullRequestNode[] } } | null;
};

type BlobObject = { isTruncated?: boolean; text?: string | null } | null;

/** 新規・改名・複製のファイルは、PRの前に同じパスの本文が無い（`null`は正常） */
const NO_BASE_CHANGE_TYPES = new Set(["ADDED", "RENAMED", "COPIED"]);

/**
 * 変更された共通知識のファイルについて、PR前後の本文を1リクエストで取る。
 *
 * **比較元は`baseRefOid`（baseブランチの現在の先端）ではなく、PRの最初のコミットの親**にする。
 * 反映PRは数日開いたままになることがあり、その間にbase側の`knowledge/`が別経路で変わると、
 * 先端との比較では他人の変更が「更新」「削除」として混ざるため。取れなければ先端で代用する。
 *
 * **存在しないパスの`null`は失敗ではない。** 新規ファイルの比較元、削除ファイルのPR側は
 * `changeType`で「本文が無いのが正常」と分かるので空文字で持つ。それ以外の`null`・切り詰められた
 * 大きなファイル・リクエスト自体の失敗は`texts: null`（行数だけの表示に落とす）。
 */
async function fetchPromotionFileTexts(
  token: string,
  pr: OpenPullRequestNode,
  files: ChangedFile[],
): Promise<RawPromotionFile[]> {
  const base = pr.commits.nodes[0]?.commit.parents.nodes[0]?.oid ?? pr.baseRefOid;
  const targets = files
    .filter((file) => isKnowledgeFilePath(file.path))
    .slice(0, KNOWLEDGE_FILES_TO_READ);

  const unread = (file: ChangedFile): RawPromotionFile => ({ ...file, texts: null });
  if (targets.length === 0) return files.map(unread);

  const declarations = targets.map((_, i) => `$b${i}: String!, $h${i}: String!`).join(", ");
  const fields = targets
    .map(
      (_, i) =>
        `b${i}: object(expression: $b${i}) { ... on Blob { isTruncated text } }\n` +
        `    h${i}: object(expression: $h${i}) { ... on Blob { isTruncated text } }`,
    )
    .join("\n    ");
  const query = `query KnowledgePromotionFiles($owner: String!, $repo: String!, ${declarations}) {
  repository(owner: $owner, name: $repo) {
    ${fields}
  }
}`;
  const variables: Record<string, unknown> = { owner: DOCS_OWNER, repo: DOCS_REPO };
  targets.forEach((file, i) => {
    variables[`b${i}`] = `${base}:${file.path}`;
    variables[`h${i}`] = `${pr.headRefOid}:${file.path}`;
  });

  let data: { repository: Record<string, BlobObject> | null };
  try {
    data = await githubGraphql(token, query, variables, "fetchPromotionFileTexts", {
      permissionHint: "（共有知識リポジトリを読む権限が要ります）",
    });
  } catch (error) {
    console.error("[fetchPromotionFileTexts]", error);
    return files.map(unread);
  }

  const readBlob = (blob: BlobObject | undefined, absentIsNormal: boolean): string | null => {
    if (blob && typeof blob.text === "string" && !blob.isTruncated) return blob.text;
    return !blob && absentIsNormal ? "" : null;
  };

  const readTexts = new Map<string, RawPromotionFile["texts"]>();
  targets.forEach((file, i) => {
    const before = readBlob(data.repository?.[`b${i}`], NO_BASE_CHANGE_TYPES.has(file.changeType));
    const after = readBlob(data.repository?.[`h${i}`], file.changeType === "DELETED");
    readTexts.set(file.path, before !== null && after !== null ? { base: before, head: after } : null);
  });
  return files.map((file) => ({ ...file, texts: readTexts.get(file.path) ?? null }));
}

/**
 * `guchi-apps/docs`のオープンなPull Requestのうち、格上げ判定が作った反映PR
 * （ブランチ名が`knowledge/promote-`で始まるもの）だけを取る。
 *
 * これが残っている間、`promote-knowledge.yml`は次回の判定を見送る（#126）。issue-deckの
 * 「共通知識」画面はマージ操作を持たないため、ここでは一覧を返すだけで判定・マージは行わない。
 * 各PRには、マージで共通知識へ入る内容を出すために、変更された`knowledge/*.md`の前後の本文も
 * 付ける（#3107）。
 *
 * **読めなかったときは例外にせず空で返す**（`fetchKnowledgeFiles`と同じ方針）。
 */
export async function fetchOpenPromotionPullRequests(
  token: string,
): Promise<RawPromotionPullRequest[]> {
  let data: OpenPullRequestsResponse;
  try {
    data = await githubGraphql<OpenPullRequestsResponse>(
      token,
      OPEN_PULL_REQUESTS_QUERY,
      { owner: DOCS_OWNER, repo: DOCS_REPO, first: OPEN_PULL_REQUESTS_TO_SCAN },
      "fetchOpenPromotionPullRequests",
      { permissionHint: "（共有知識リポジトリのPull Requestを読む権限が要ります）" },
    );
  } catch (error) {
    console.error("[fetchOpenPromotionPullRequests]", error);
    return [];
  }

  const nodes = data.repository?.pullRequests.nodes ?? [];
  return Promise.all(
    nodes
      .filter((node) => node.headRefName.startsWith(PROMOTION_BRANCH_PREFIX))
      .map(async (node) => ({
        number: node.number,
        title: node.title,
        htmlUrl: node.url,
        createdAt: node.createdAt,
        body: node.body,
        files: await fetchPromotionFileTexts(token, node, node.files?.nodes ?? []),
      })),
  );
}

const MEMO_QUERY = `
query KnowledgeMemos($q: String!, $issues: Int!, $comments: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $issues, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number
        title
        url
        repository { nameWithOwner }
        comments(last: $comments) { nodes { body createdAt } }
      }
    }
  }
}`;

type MemoResponse = {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ({
      number?: number;
      title?: string;
      url?: string;
      repository?: { nameWithOwner: string };
      comments?: { nodes: { body: string; createdAt: string }[] };
    } | null)[];
  };
};

export type KnowledgeMemosResult = {
  issues: RawIssue[];
  truncated: boolean;
};

/**
 * フリート各リポジトリのIssueから、知見メモを持つ可能性のあるものを取る。
 *
 * **ここでは絞り込まない。** 検索は本文一致も拾うため、実際にコメント側へマーカーがあるかは
 * `buildCandidate`（`lib/knowledge-board.ts`）が見る。取得と解釈を分けておくと、書式の揺れへの
 * 対処をテストできる純粋関数の側だけで直せる。
 */
export async function fetchKnowledgeMemos(token: string): Promise<KnowledgeMemosResult> {
  const issues: RawIssue[] = [];
  let after: string | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data: MemoResponse = await githubGraphql<MemoResponse>(
      token,
      MEMO_QUERY,
      {
        q: MEMO_SEARCH_QUERY,
        issues: ISSUES_PER_PAGE,
        comments: COMMENTS_PER_ISSUE,
        after,
      },
      "fetchKnowledgeMemos",
      { permissionHint: "（フリート各リポジトリのIssueを読む権限が要ります）" },
    );

    for (const node of data.search.nodes) {
      if (!node?.number || !node.repository || !node.url) continue;
      issues.push({
        repoFullName: node.repository.nameWithOwner,
        number: node.number,
        title: node.title ?? "",
        htmlUrl: node.url,
        comments: node.comments?.nodes ?? [],
      });
    }

    if (!data.search.pageInfo.hasNextPage) return { issues, truncated: false };
    after = data.search.pageInfo.endCursor;
    truncated = true;
  }

  return { issues, truncated };
}

/**
 * 格上げ判定エージェントが1回の実行で集める上限。
 *
 * **正は`guchi-apps/docs`の`.github/workflows/promote-knowledge.yml`**（収集ステップの
 * `gh search issues … --limit 200 --sort created --order asc`）。ここに写しを置いているのは、
 * 「判定済みの件数がこの数に達した＝収集の窓が判定済みで埋まっている」という**画面でしか
 * 気付けない詰まり方**を出すため（#2912）。
 *
 * 窓は**作成の古い順**なので、判定済みの件数はこの数を超えない。超えないまま張り付いたときは、
 * 新しい知見メモが構造的に窓の外にあり、ワークフローは毎晩`success`で終わりながら1件も
 * 判定しない。**向こうの上限を変えたらここも変える**（ずれると警告が出ない・誤って出る）。
 */
export const PROMOTION_COLLECT_LIMIT = 200;

/** 知見メモの総数（検索の`total_count`から取る概算） */
export type KnowledgeMemoCounts = {
  /** 知見メモを持つIssueの総数 */
  total: number | null;
  /** うち、判定コメントがまだ無いもの */
  unjudged: number | null;
  /** うち、判定済み */
  judged: number | null;
};

/**
 * 知見メモの総数を、検索の`total_count`から取る。
 *
 * **一覧のほうは検索を300件で打ち切っている**ので、そのままでは「未判定が何件あるか」が
 * 表示範囲での下限にしかならない。総数は1リクエストで返るため、KPIだけはこちらから出す。
 *
 * **これは概算**——GitHubのIssue検索は本文で言及しているだけのIssueも拾う（この仕組みを
 * 設計したIssue・プロンプトを直したIssueなど）。実測で5%ほど多く出る。行全体一致で
 * 確かめた件数は一覧の側が持つので、画面では役割を分けて出す。
 *
 * **否定は`NOT`で書く。** `-"knowledge-promotion:judged"`のハイフンによる否定は効かず、
 * 判定済みの件数がそのまま返る（除外できていないことに気付けない）。
 */
export async function fetchKnowledgeMemoCounts(token: string): Promise<KnowledgeMemoCounts> {
  const base = `org:${DOCS_OWNER} "knowledge-candidate" in:comments`;

  async function count(query: string): Promise<number | null> {
    try {
      const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&per_page=1`;
      const res = await githubFetch(url, token);
      if (!res.ok) return null;
      const json = (await res.json()) as { total_count?: number };
      return typeof json.total_count === "number" ? json.total_count : null;
    } catch (error) {
      console.error("[fetchKnowledgeMemoCounts]", error);
      return null;
    }
  }

  const [total, unjudged] = await Promise.all([
    count(base),
    count(`${base} NOT "knowledge-promotion:judged"`),
  ]);

  return {
    total,
    unjudged,
    judged: total !== null && unjudged !== null ? total - unjudged : null,
  };
}
