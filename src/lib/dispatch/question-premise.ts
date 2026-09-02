import {
  COMMENT_AGENT_PROFILES,
  commentAgentRole,
  isMarkedAutomationComment,
  resolveCommentSource,
  type CommentAgentRole,
} from "@/lib/github/comment-source";
import type { IssueComment } from "@/types/issue";

/**
 * 質問パネルに出す「この質問の前提」（#2742）。
 *
 * **`AskUserQuestion`の質問文は、直前に自分が投稿したコメントを指していることが多い**
 * （「上記の計画で実装を進めてよいですか？」）。ところが画面では、その計画はコメント欄の
 * ずっと下にあり、選択肢を見ながら読み返せない——スマホでは特に、読みに行くと選択肢が
 * 画面外へ出る。質問と一緒に読めるよう、直前のコメントをパネルの中へ持ってくる。
 *
 * **質問とコメントを結ぶデータは無い。** 質問（`SessionQuestionRequest`）はリポジトリと
 * Issue番号でしか紐付いておらず、どのコメントを指しているかはツール入力に現れない。
 * そこで**取得済みのコメントの末尾から、エージェントが書いた最新の1件**を前提として扱う。
 * 断定できない以上、画面には役割（計画ボットなど）と投稿時刻を必ず添えて、読む側が
 * 「これは今の質問と関係がある発言か」を判断できるようにする。
 */
export type QuestionPremise = {
  /** コメント本文（マーカーのHTMLコメントもそのまま。Markdownとして描画すると消える） */
  body: string;
  /** 役割の表示名（例: 「計画ボット」）。コメント欄の吹き出しと同じ呼び方に揃える */
  roleLabel: string;
  /** 役割。アイコンの出し分けに使う */
  role: CommentAgentRole;
  /** 相対時刻（`IssueComment.createdAtLabel`。例: 「3分前」） */
  createdAtLabel: string;
};

/**
 * 前提として出してよい役割。
 *
 * **案内ボット（`guide`）と通知ボット（`notifier`）は除く。** 受付コメント（「対応を開始します」）
 * と締めのコメント、PR作成の通知が前提として出ても、質問の判断材料にならない。
 * **回答ボット（`responder`）も除く**——質問への回答そのもの（「🙋 質問に回答しました」）で、
 * これを前提にすると前の回答が今の質問の前提として出る。
 */
const PREMISE_ROLES: readonly CommentAgentRole[] = [
  "planner",
  "splitter",
  "implementer",
  "reviewer",
  "conflict-resolver",
  "ci-fixer",
];

/**
 * 質問の前提として出すコメントを選ぶ。見つからなければ`null`（パネルはカードごと描かない）。
 *
 * **人が書いたコメントは対象にしない。** ローカルセッションの`gh`はユーザー本人のトークンで
 * 動くため投稿者名では区別できないので、本文のマーカーで自動投稿と断定できるものだけを見る
 * （`isMarkedAutomationComment`。書き出しの絵文字による推測は含まれない）。
 *
 * @param comments 取得順（古い→新しい）のコメント一覧
 */
export function findQuestionPremise(
  comments: readonly IssueComment[] | null | undefined,
): QuestionPremise | null {
  if (!comments) return null;

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    const resolved = resolveCommentSource(comment, comment.author.login);
    if (!isMarkedAutomationComment(resolved)) continue;
    const role = resolved ? commentAgentRole(resolved) : null;
    if (!role || !PREMISE_ROLES.includes(role)) continue;
    const body = comment.body.trim();
    if (!body) continue;
    return {
      body,
      role,
      roleLabel: COMMENT_AGENT_PROFILES[role].label,
      createdAtLabel: comment.createdAtLabel,
    };
  }

  return null;
}
