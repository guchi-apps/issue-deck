import { describe, expect, it } from "vitest";

import { extractLatestWorkflowRunId, findLatestWorkflowRunLogComment } from "@/lib/github/workflow-run-log";
import type { IssueComment } from "@/types/issue";

function comment(id: string, body: string): IssueComment {
  return { id, author: { login: "github-actions" }, createdAtLabel: "1分前", body, reactionCount: 0 };
}

describe("findLatestWorkflowRunLogComment", () => {
  it("最新の「実行ログ:」リンクを含むコメントのIDとrun_idを返す", () => {
    const comments = [
      comment("1", "🔧 依頼を確認しました。\n\n実行ログ: https://github.com/owner/repo/actions/runs/111"),
      comment("2", "⚠️ 実行ステップが終了しました。\n\n実行ログ: https://github.com/owner/repo/actions/runs/222"),
    ];
    expect(findLatestWorkflowRunLogComment(comments, "owner", "repo")).toEqual({
      commentId: "2",
      runId: 222,
    });
  });

  it("owner/repoが一致しないリンクは無視する", () => {
    const comments = [
      comment("1", "実行ログ: https://github.com/other/repo/actions/runs/111"),
    ];
    expect(findLatestWorkflowRunLogComment(comments, "owner", "repo")).toBeNull();
  });

  it("該当リンクが無ければnullを返す", () => {
    expect(findLatestWorkflowRunLogComment([comment("1", "通常のコメント")], "owner", "repo")).toBeNull();
  });
});

describe("extractLatestWorkflowRunId", () => {
  it("最新の「実行ログ:」リンクからrun_idのみを取り出す", () => {
    const comments = [comment("1", "実行ログ: https://github.com/owner/repo/actions/runs/333")];
    expect(extractLatestWorkflowRunId(comments, "owner", "repo")).toBe(333);
  });
});
