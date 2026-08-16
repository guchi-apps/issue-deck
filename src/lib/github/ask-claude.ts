import { isFallbackNoticeComment } from "@/lib/github/fallback-notice";
import type { Issue, IssueComment } from "@/types/issue";

/**
 * 質問コメントに付けるマーカー（#1294）。**「質問である」ことの唯一の目印**で、回答側の
 * `QA_ANSWER_MARKER`と対になる。
 *
 * 従来はActionsの起動トリガーそのもの（`@claude 質問: `プレフィックス）で質問かどうかを
 * 判定していたが、それだと**同じコメントをサブPCにも処理させた時点で必ず二重に回答する**
 * （#1290）。「Issueに残す質問コメント」と「Actionsを起こすトリガー」を別の軸にするため、
 * 識別はこのマーカーへ移し、トリガーは本文の先頭に`@claude`を置くかどうかで決める。
 */
export const QUESTION_COMMENT_MARKER = "<!-- issue-deck-question -->";

/**
 * 質問コメントのうち、**GitHub Actions（claude-issue-dispatch.yml）を起こす形**の先頭に置く
 * プレフィックス。reusable-issue-dispatch.ymlのmode=ask判定に使う。
 *
 * **この文字列を変えたり外したりしてはいけない。** 他リポジトリは
 * reusable-issue-dispatch.ymlをタグ固定（`@workflows/vX`）で参照しており、古いタグの
 * `IS_ASK`はこのプレフィックスしか見ない。issue-deckが投稿する本文の形を変えると、
 * 古いタグのリポジトリでは質問がmode=askに落ちず**実装モードとして走る**。
 */
export const ASK_CLAUDE_COMMENT_PREFIX = "@claude 質問: ";

/**
 * 質問コメントの投稿先（＝誰に答えさせるか）。
 *
 * - `actions` … 従来どおりGitHub Actionsに答えさせる（現状の唯一の経路）
 * - `none` … どこも起こさない。**サブPC側で実行する場合に使う**（#1294のStep 3で開ける）。
 *   本文に`@claude`を含めないため、Actionsのトリガー条件
 *   （`startsWith(github.event.comment.body, '@claude')`）に掛からない
 */
export type QuestionCommentTrigger = "actions" | "none";

/**
 * 質問コメントの本文を組み立てる。**識別のマーカーは常に付き、トリガーの有無だけが変わる。**
 */
export function askClaudeCommentBody(
  question: string,
  options?: { trigger?: QuestionCommentTrigger },
): string {
  const trigger = options?.trigger ?? "actions";
  const prefix = trigger === "actions" ? ASK_CLAUDE_COMMENT_PREFIX : "";
  return `${prefix}${question.trim()}\n\n${QUESTION_COMMENT_MARKER}`;
}

/**
 * 「Claudeに質問する」ボタンは、実装状況によらずopenなissueであればいつでも
 * 表示する（コード変更を伴わない読み取り専用の質問のため、実装中・承認待ち等の
 * 状態を問わず利用できる）。
 */
export function canAskClaude(issue: Pick<Issue, "state">): boolean {
  return issue.state === "open";
}

/**
 * claude-issue-dispatch.ymlが質問への回答コメントを投稿する際に末尾へ付与するマーカー
 * （mode=ask、mode=plan・mode=additionalで「単なる質問・確認」と判定した場合の回答が対象）。
 */
export const QA_ANSWER_MARKER = "<!-- issue-deck-qa-answer -->";

/** 指定したコメントが、上記の質問への回答コメントかどうかを判定する */
export function isQaAnswerComment(comment: Pick<IssueComment, "body">): boolean {
  return comment.body.includes(QA_ANSWER_MARKER);
}

/**
 * 指定したコメントが、「Claudeに質問する」ダイアログ経由の質問コメントかどうかを判定する。
 *
 * **新旧どちらの形式も質問として認識する**（#1294）。マーカーを持たない
 * `@claude 質問: `形式のコメントが既にIssueへ積まれており、そちらを質問として扱わなくなると、
 * 回答待ちの表示とワンボタンクローズ（`canCloseAskRepoQuestion`）の挙動が既存Issueで変わる。
 */
export function isAskClaudeQuestionComment(comment: Pick<IssueComment, "body">): boolean {
  return (
    comment.body.includes(QUESTION_COMMENT_MARKER) ||
    comment.body.startsWith(ASK_CLAUDE_COMMENT_PREFIX)
  );
}

/**
 * コメント配列（時系列順）を末尾から走査し、直近の質問コメント（isAskClaudeQuestionComment）が
 * 回答コメント（isQaAnswerComment）より後に投稿されている、すなわち「回答待ち」かどうかを判定する。
 *
 * **回答できなかったことの通知（フォールバック通知）でも回答待ちを終える**（#1766）。質問への
 * 回答は、行き詰まりやエラーで回答コメントに到達できないまま終わることがある。回答コメントだけを
 * 終わりの合図にすると、その質問は画面上いつまでも「Claudeの回答待ち」のままになり、質問Issueの
 * ワンボタンクローズ（`canCloseAskRepoQuestion`）も出てこない。
 */
export function isQaAnswerPending(comments: Pick<IssueComment, "body">[]): boolean {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (isQaAnswerComment(comment)) return false;
    if (isFallbackNoticeComment(comment)) return false;
    if (isAskClaudeQuestionComment(comment)) return true;
  }
  return false;
}

/**
 * 複数リポジトリ横断の質問（#1454）であることの目印。**回答するのはサブPCの質問セッションで、
 * GitHub Actionsではない。**
 *
 * `QUESTION_COMMENT_MARKER`と併せて付ける（質問であることの識別はあちらが持ち、こちらは
 * 「どの経路が答えるか」を画面へ出すためのもの）。本文に`@claude`を含めないため、
 * `claude-issue-dispatch.yml`のトリガー条件には掛からない。
 */
export const CROSS_REPO_QUESTION_MARKER = "<!-- issue-deck-cross-repo-question -->";

/**
 * 横断質問のコメント本文を組み立てる。**Actionsを起こさない形**（`trigger: "none"`）に
 * 横断質問のマーカーを足したもの。
 */
export function crossRepoQuestionCommentBody(question: string): string {
  return `${askClaudeCommentBody(question, { trigger: "none" })}\n${CROSS_REPO_QUESTION_MARKER}`;
}

/** 指定したコメントが横断質問（#1454）かどうかを判定する */
export function isCrossRepoQuestionComment(comment: Pick<IssueComment, "body">): boolean {
  return comment.body.includes(CROSS_REPO_QUESTION_MARKER);
}

/**
 * 横断質問Issueの既定の置き場所として探すリポジトリ名（#1454）。
 *
 * **`owner`は問わず、リポジトリ名だけで探す。** 質問Issueが実装対象のリポジトリへ混ざると、
 * そのリポジトリのIssue一覧・カンバンが質問で埋まるため、専用リポジトリを既定にしている。
 * 設定値（AppSetting・環境変数）を増やさないのは、**リポジトリを作って連携した時点で
 * 自動的に既定になる**ようにするため。
 */
export const CROSS_REPO_QUESTION_REPOSITORY_NAME = "question";

/**
 * 横断質問Issueの記録先として既定で選ぶリポジトリを決める（#1454）。
 *
 * 名前が`question`のリポジトリがあればそれ、無ければ`fallback`（呼び出し元が渡す従来の既定＝
 * 選択中のリポジトリか一覧の先頭）。**`question`リポジトリが未作成でも機能そのものは動く**
 * ようにするためのフォールバックで、リポジトリ名をもう1つハードコードはしない。
 */
export function resolveCrossRepoQuestionRepository(
  repositoryFullNames: readonly string[],
  fallback: string | null,
): string | null {
  const preferred = repositoryFullNames.find(
    (fullName) => fullName.split("/")[1] === CROSS_REPO_QUESTION_REPOSITORY_NAME,
  );
  return preferred ?? fallback;
}

/**
 * 質問フローがIssueタイトルに付与する接頭辞。
 * このタイトルを持つIssueかどうかで、質問フロー由来のIssueかを判定する（#885）。
 */
export const ASK_REPO_QUESTION_TITLE_PREFIX = "[質問] ";

/** 質問文から機械的に組み立てるIssueタイトルの、接頭辞を除いた最大長 */
const ASK_REPO_QUESTION_TITLE_MAX_LENGTH = 40;

/**
 * 質問文からIssueタイトルを機械的に生成する（Claudeによる自動生成は行わない）。
 * 改行・連続空白は1つの半角スペースにまとめ、長い質問は末尾を省略記号で丸める。
 *
 * **単一リポジトリへの質問（新規作成ダイアログの「質問」種別・#1641）と横断質問
 * （CrossRepoQuestionDialog・#1454）で共有する。** どちらも同じ接頭辞で作られた質問Issueとして
 * `isAskRepoQuestionIssue`に拾われる必要があるため、生成はここ1か所に置く。
 */
export function buildAskRepoQuestionTitle(question: string): string {
  const normalized = question.trim().replace(/\s+/g, " ");
  const truncated =
    normalized.length > ASK_REPO_QUESTION_TITLE_MAX_LENGTH
      ? `${normalized.slice(0, ASK_REPO_QUESTION_TITLE_MAX_LENGTH)}…`
      : normalized;
  return `${ASK_REPO_QUESTION_TITLE_PREFIX}${truncated}`;
}

/**
 * 上記接頭辞の**旧形式**（#1514で`[質問] `へ変更する前のもの）。
 *
 * **判定では引き続き受け付ける。** 既にGitHub上に作られている質問Issueのタイトルは
 * この形のままで、片方しか見ないと既存分が「質問」ビューにも詳細画面のワンボタンクローズにも
 * 出てこなくなる。タイトルの一括リネームは行わない（判定が両対応なら不要なうえ、GitHub側への
 * 一括書き込みになる）。受け入れを消せるのは、旧形式の質問Issueが全てcloseされたあと。
 *
 * なおコメント側のトリガー接頭辞`ASK_CLAUDE_COMMENT_PREFIX`（`@claude 質問: `）は別物で、
 * 他リポジトリのワークフローの起動条件と対になっているため変更していない。
 */
export const ASK_REPO_QUESTION_TITLE_PREFIX_LEGACY = "質問: ";

/** 「リポジトリに質問する」ダイアログ経由で作成されたIssueかどうかを判定する */
export function isAskRepoQuestionIssue(issue: Pick<Issue, "title">): boolean {
  return (
    issue.title.startsWith(ASK_REPO_QUESTION_TITLE_PREFIX) ||
    issue.title.startsWith(ASK_REPO_QUESTION_TITLE_PREFIX_LEGACY)
  );
}

/**
 * 質問Issueをワンボタンでクローズできるようにするための表示条件。
 * open状態かつ質問Issueであり、かつ回答待ちではない（回答が来る前に誤ってクローズするのを防ぐ）
 * 場合のみtrueを返す。
 */
export function canCloseAskRepoQuestion(
  issue: Pick<Issue, "state" | "title">,
  comments: Pick<IssueComment, "body">[],
): boolean {
  return issue.state === "open" && isAskRepoQuestionIssue(issue) && !isQaAnswerPending(comments);
}
