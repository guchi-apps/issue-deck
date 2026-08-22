import { PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import { commentAgentRole, resolveCommentSource } from "@/lib/github/comment-source";
import { getProgressStatusIndex, resolveProgressStatus } from "@/lib/issue-progress";
import type { Issue, IssueComment, IssueLabel } from "@/types/issue";

/**
 * そのIssueが計画フェーズ（`Planning`）を通ったかどうか（#2069）。
 *
 * - `planned`: 計画を提示して承認まで通った（またはこれから通す）
 * - `skipped`: 計画フェーズを通らず実装へ直行した
 * - `unknown`: まだ判定できない（計画フェーズ以前・コメント未取得）
 */
export type PlanningPhaseState = "planned" | "skipped" | "unknown";

/**
 * `ExitPlanMode`のフックが自動投稿する計画コメントのマーカー
 * （正は`@/lib/dispatch/session-plan`の`SESSION_PLAN_MARKER`）。
 *
 * **あちらから import せず文字列で持つ。** `session-plan.ts`はGitHub Appのトークン解決と
 * ジョブの積み込みを抱えたサーバー専用モジュールで、画面（クライアントコンポーネント）から
 * 辿るとサーバー側のコードごとバンドルへ引きずり込む。同じ理由で
 * `session-wrapup.ts`もこのマーカーを文字列で持っている。
 *
 * 代わりに、**正とずれたら落ちるテスト**を`planning-phase.test.ts`に置いている
 * （テストはサーバー側のモジュールを読んでよい）。
 */
export const SESSION_PLAN_COMMENT_MARKER = "<!-- issue-deck:session-plan -->";

/** 計画として投稿されたコメントかどうか。無人実行・ローカルセッションのどちらの経路も拾う */
function isPlanComment(comment: Pick<IssueComment, "body" | "author">): boolean {
  // `ExitPlanMode`のフック経由（#1342）。役割マーカーを持たないので先に見る
  if (comment.body.includes(SESSION_PLAN_COMMENT_MARKER)) return true;
  const resolved = resolveCommentSource(comment, comment.author.login);
  if (!resolved) return false;
  const role = commentAgentRole(resolved);
  // 無人実行の計画（`issue-deck-plan-type`）・ローカルセッションが手で投稿した計画
  // （`issue-deck-agent:planner`）・マーカー導入前の絵文字（🔍・🔀）がここへ集まる。
  // 分割の計画（`splitter`）も計画フェーズを通った証拠なので同じ扱いにする
  return role === "planner" || role === "splitter";
}

/**
 * 計画フェーズを通ったかどうかを、ラベルとコメントから判定する（#2069）。
 *
 * **ラベル（`21.plan-required`）だけでは判定できない。** 計画の承認時に外れる
 * （`labelsAfterApproval`）ため、承認済みのIssueと最初から計画を求めなかったIssueが
 * 同じ見た目になる。そこで、承認されると消えるラベルの代わりに**Issueへ残り続ける
 * 計画コメント**を根拠にする。
 *
 * **判定できないときは`skipped`と言い切らない。** 進捗ステッパーは判定できない間
 * 従来どおりの表示（済みのチェック）に留め、「スキップ」と出してから戻るのを避ける。
 */
export function resolvePlanningPhase(params: {
  labels: IssueLabel[];
  projectStatus: string | null;
  /** 取得済みのコメント。未取得なら`null`（この場合は`unknown`になる） */
  comments: readonly Pick<IssueComment, "body" | "author">[] | null;
}): PlanningPhaseState {
  const status = resolveProgressStatus({ projectStatus: params.projectStatus });
  // 計画フェーズより手前（未着手・計画検討中）は、まだ通り過ぎていないのでスキップではない
  if (getProgressStatusIndex(status) <= getProgressStatusIndex("planning")) return "unknown";
  // 計画が要ると分かっているIssue（承認前・計画のやり直し中）はスキップではない
  if (params.labels.some((label) => label.name === PLAN_REQUIRED_LABEL)) return "planned";
  if (params.comments === null) return "unknown";
  return params.comments.some(isPlanComment) ? "planned" : "skipped";
}

/**
 * 進捗ステッパーへ渡す「計画フェーズを通っていない」判定（#2069）。
 *
 * コメントの取得中は判定材料が揃っていないため`false`（＝従来どおりの表示）を返す。
 * **`commentCount`と突き合わせる**のは、取得前の空配列を「コメントが1件も無いIssue」と
 * 取り違えないため。取得が終わる前に一瞬「計画スキップ」と出てから戻るのが最も紛らわしい。
 */
export function isPlanningPhaseSkipped(
  issue: Pick<Issue, "labels" | "projectStatus" | "commentCount">,
  comments: readonly IssueComment[],
  isLoadingComments: boolean,
): boolean {
  const loaded = !isLoadingComments && (comments.length > 0 || issue.commentCount === 0);
  return (
    resolvePlanningPhase({
      labels: issue.labels,
      projectStatus: issue.projectStatus,
      comments: loaded ? comments : null,
    }) === "skipped"
  );
}
