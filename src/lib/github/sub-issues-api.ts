import { githubGraphql } from "@/lib/github/graphql";

/**
 * GitHubネイティブのサブIssue（親子関係）との境界。
 *
 * **親子関係の唯一の正はここで取れるネイティブの関係**で、本文中の「親: #N」「分割元: #N」
 * といったテキストは人が読む補助に過ぎない（表記が3種類に割れており、本文編集で壊れる）。
 * 運用は docs/multi-agent/labels.md を参照。
 *
 * REST（`/issues/{n}/sub_issues`）でも取れるが、親と子を1往復で取りたいのでGraphQLを使う。
 */

/** 権限不足だったときにメッセージへ添えるヒント */
const SUB_ISSUES_PERMISSION_HINT = "（GitHub Appのrepository permission「Issues: Read」が必要です）";

/**
 * 一度に取得する子Issueの上限。分割の運用上6件程度が目安（`.github/prompts/split.md`）なので
 * ページングは持たない。超えた分は`totalCount`との差として画面に出す。
 */
const SUB_ISSUE_PAGE_SIZE = 100;

export type GithubSubIssueRef = {
  number: number;
  title: string;
  /** GitHub上のIssueの状態。GraphQLは`OPEN`/`CLOSED`で返すので小文字へ寄せる */
  state: "open" | "closed";
  htmlUrl: string;
};

export type GithubSubIssueRelations = {
  /** 親Issue。無ければnull */
  parent: GithubSubIssueRef | null;
  /** 子Issue。無ければ空配列 */
  children: GithubSubIssueRef[];
  /** 子Issueの総数。`children.length`より多い場合、取得しきれていない分がある */
  childCount: number;
};

type RawIssueRef = {
  number: number;
  title: string;
  state: string;
  url: string;
};

type RawResponse = {
  repository: {
    issue: {
      parent: RawIssueRef | null;
      subIssues: { totalCount: number; nodes: RawIssueRef[] };
    } | null;
  } | null;
};

const QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      parent { number title state url }
      subIssues(first: $first) {
        totalCount
        nodes { number title state url }
      }
    }
  }
}
`;

function toRef(raw: RawIssueRef): GithubSubIssueRef {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state === "CLOSED" ? "closed" : "open",
    htmlUrl: raw.url,
  };
}

/**
 * 1つのIssueの親子関係を取得する。存在しないIssueや関係が無いIssueでも例外にせず、
 * 空の関係を返す（画面側は関係が無ければ何も描かないため、エラーと区別する必要が無い）。
 */
export async function fetchSubIssueRelations(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<GithubSubIssueRelations> {
  const data = await githubGraphql<RawResponse>(
    token,
    QUERY,
    { owner, repo, number, first: SUB_ISSUE_PAGE_SIZE },
    "fetchSubIssueRelations",
    { permissionHint: SUB_ISSUES_PERMISSION_HINT },
  );

  const issue = data.repository?.issue;
  if (!issue) {
    return { parent: null, children: [], childCount: 0 };
  }

  return {
    parent: issue.parent ? toRef(issue.parent) : null,
    children: (issue.subIssues?.nodes ?? []).map(toRef),
    childCount: issue.subIssues?.totalCount ?? 0,
  };
}
