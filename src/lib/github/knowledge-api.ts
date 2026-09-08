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
import type { RawIssue, RawKnowledgeFile } from "@/lib/knowledge-board";

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
    .filter((entry) => entry.type === "blob" && entry.name.endsWith(".md"))
    // README.mdは索引であって知見ではない（`##`見出しが索引の節になってしまう）
    .filter((entry) => entry.name !== "README.md")
    .filter((entry) => typeof entry.object?.text === "string" && !entry.object.isTruncated)
    .map((entry) => ({ path: `${KNOWLEDGE_DIR}/${entry.name}`, text: entry.object!.text! }));

  return { files, docsRepoUrl: data.repository?.url ?? fallback.docsRepoUrl };
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
