import type { IssueComment } from "@/types/issue";

// .github/workflows/claude-issue-dispatch.yml・issue-labels.yml が無人実行の追跡用に
// コメント末尾へ付与する「実行ログ: <URL>」形式のリンクから run_id を取り出す。
const RUN_LOG_URL_PATTERN = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)/;

/** コメント一覧のうち最新の「実行ログ:」リンクから run_id を抽出する。該当リンクがなければ null */
export function extractLatestWorkflowRunId(
  comments: IssueComment[],
  owner: string,
  repo: string,
): number | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const match = comments[i].body.match(RUN_LOG_URL_PATTERN);
    if (match && match[1] === owner && match[2] === repo) {
      return Number(match[3]);
    }
  }
  return null;
}
