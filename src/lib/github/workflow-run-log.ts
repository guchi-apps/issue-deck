import type { IssueComment } from "@/types/issue";

// .github/workflows/claude-issue-dispatch.yml・issue-labels.yml が無人実行の追跡用に
// コメント末尾へ付与する「実行ログ: <URL>」形式のリンクから run_id を取り出す。
const RUN_LOG_URL_PATTERN = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)/;

export type WorkflowRunLogMatch = {
  /** 実行時間の表示を「該当するコメントの横」に配置できるよう、リンクを含んでいたコメントのIDも合わせて返す */
  commentId: string;
  runId: number;
};

/** コメント一覧のうち最新の「実行ログ:」リンクを含むコメントとrun_idを返す。該当リンクがなければ null */
export function findLatestWorkflowRunLogComment(
  comments: IssueComment[],
  owner: string,
  repo: string,
): WorkflowRunLogMatch | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const match = comments[i].body.match(RUN_LOG_URL_PATTERN);
    if (match && match[1] === owner && match[2] === repo) {
      return { commentId: comments[i].id, runId: Number(match[3]) };
    }
  }
  return null;
}

/** コメント一覧のうち最新の「実行ログ:」リンクから run_id を抽出する。該当リンクがなければ null */
export function extractLatestWorkflowRunId(
  comments: IssueComment[],
  owner: string,
  repo: string,
): number | null {
  return findLatestWorkflowRunLogComment(comments, owner, repo)?.runId ?? null;
}
