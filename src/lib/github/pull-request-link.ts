import type { IssueComment } from "@/types/issue";

// claude-issue-dispatch.yml・claude-review-develop.yml等が無人実行の報告コメント内に
// 埋め込む「https://github.com/<owner>/<repo>/pull/<number>」形式のリンクを取り出す。
const PR_URL_PATTERN = /https:\/\/github\.com\/([^/\s]+)\/([^/\s)]+)\/pull\/(\d+)/g;

export type PullRequestLink = {
  url: string;
  number: number;
};

/** コメント一覧のうち最新の対応PRリンクを抽出する。該当リンクがなければnull */
export function extractLatestPullRequestLink(
  comments: IssueComment[],
  owner: string,
  repo: string,
): PullRequestLink | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const matches = [...comments[i].body.matchAll(PR_URL_PATTERN)];
    for (let j = matches.length - 1; j >= 0; j -= 1) {
      const match = matches[j];
      if (match[1] === owner && match[2] === repo) {
        return { url: match[0], number: Number(match[3]) };
      }
    }
  }
  return null;
}
