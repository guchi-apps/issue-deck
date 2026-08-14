import type { IssueComment } from "@/types/issue";

// claude-issue-dispatch.yml・claude-review-develop.yml等が無人実行の報告コメント内に
// 埋め込む「https://github.com/<owner>/<repo>/pull/<number>」形式のリンクを取り出す。
const PR_URL_PATTERN = /https:\/\/github\.com\/([^/\s]+)\/([^/\s)]+)\/pull\/(\d+)/g;

export type PullRequestLink = {
  url: string;
  number: number;
};

/**
 * コメント一覧に現れる対応PRリンクをすべて抽出する（#1339）。
 *
 * 1つのIssueに複数のPRがぶら下がることがあるため、最新1件ではなく全件を返す。同じPRが
 * 複数のコメントで言及されるのが普通（実装の報告・レビューの報告）なので番号でdedupeし、
 * 番号の昇順＝作成順に近い並びで返す。
 *
 * ここで拾えるのは「同一リポジトリのPRのURLがコメントに書かれている」ことだけで、そのPRが
 * 本当にこのIssueの対応PRかは判断できない（「#1327を参考に」のような言及も混ざる）。
 * 実際に対応PRとして扱うかどうかの絞り込みは`lib/issue-pull-requests.ts`が、GitHubから
 * 取得したPRのブランチ名・タイトル・本文を見て行う。
 */
export function extractPullRequestLinks(
  comments: IssueComment[],
  owner: string,
  repo: string,
): PullRequestLink[] {
  const byNumber = new Map<number, PullRequestLink>();

  for (const comment of comments) {
    for (const match of comment.body.matchAll(PR_URL_PATTERN)) {
      if (match[1] !== owner || match[2] !== repo) continue;
      const number = Number(match[3]);
      if (byNumber.has(number)) continue;
      byNumber.set(number, { url: match[0], number });
    }
  }

  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}
