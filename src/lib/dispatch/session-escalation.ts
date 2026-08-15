import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { addIssueLabels, createComment, removeIssueLabel } from "@/lib/github/issues-api";
import { parseRepositoryFullName } from "@/lib/local-session";

/**
 * 実装セッションの異常終了を人へ引き上げる（#1217）。
 *
 * 経路は`report-progress.ts`と同じで、対象リポジトリのインストールトークンを取ってから
 * IssueへコメントとラベルをGitHub Appの名義で書く。サブPCにGitHubの認証を持たせないための
 * 一本化（[docs/progress-status-architecture.md](../../../docs/progress-status-architecture.md)）と
 * 同じ考え方。
 *
 * **画面（`capture-pane`）の内容は載せない。** 実装中のコード・環境変数が映りうるため、
 * そもそも取得していない。代わりに`tmux attach`の案内を出して、見に行ける状態にする。
 */

/** 引き上げたことを示すマーカー。同じ内容の重複投稿を人が見分けられるようにする */
const SESSION_FAILED_MARKER = "<!-- supervisor:session-failed -->";

/** Claude Codeが開始しないまま止まっていることを知らせたマーカー（#1465） */
const SESSION_NOT_STARTED_MARKER = "<!-- supervisor:session-not-started -->";

/** ユーザーの確認が必要であることを示すラベル */
const CHECK_USER_LABEL = "00.check-user";

export function buildSessionFailedCommentBody(params: {
  hostName: string;
  tmuxSessionName: string;
  exitStatus: number | null;
}): string {
  const exit =
    params.exitStatus === null ? "不明" : `${params.exitStatus}`;
  return [
    "⚠️ このIssueの実装セッションが異常終了しました。",
    "",
    `- ホスト: \`${params.hostName}\``,
    `- tmuxセッション: \`${params.tmuxSessionName}\``,
    `- 終了コード: \`${exit}\``,
    "",
    "最後の出力はセッションのペインに残っています。次のコマンドで確認してください。",
    "",
    "```bash",
    `tmux attach -t ${params.tmuxSessionName}`,
    "```",
    "",
    "作業を再開する場合は、worktreeを作り直さずに `scripts/start-issue.sh <番号>` で再開できます。",
    "",
    SESSION_FAILED_MARKER,
  ].join("\n");
}

export function buildSessionNotStartedCommentBody(params: {
  hostName: string;
  tmuxSessionName: string;
}): string {
  return [
    "⏳ このIssueの実装セッションが、Claude Codeの起動確認で止まっている可能性があります。",
    "",
    `- ホスト: \`${params.hostName}\``,
    `- tmuxセッション: \`${params.tmuxSessionName}\``,
    "",
    "tmuxセッションは立っているのに、Claude Codeのセッション開始（`SessionStart`フック）がまだ届いていません。",
    "初めてクローンしたリポジトリでは、起動直後にフォルダの信頼確認",
    "（`Is this a project you created or one you trust?`）が出て、答えるまで先へ進みません。",
    "",
    "**この確認にはRemote Controlから答えられません**（セッション自体がまだ始まっていないため接続もされていません）。端末から答えてください。",
    "",
    "```bash",
    `tmux attach -t ${params.tmuxSessionName}`,
    "```",
    "",
    "答えるとセッションはそのまま実装を始め、この`00.check-user`は自動で外れます。",
    "",
    SESSION_NOT_STARTED_MARKER,
  ].join("\n");
}

/**
 * Claude Codeが開始しないまま止まっていることをIssueへ知らせ、`00.check-user`を付ける（#1465）。
 *
 * **`escalateFailedSession`と同じく、失敗しても例外を投げない。** 呼び出し元
 * （`reportDispatchSessions`）は状態を保存し終えており、ここで落としてもpollerにできることは無い。
 */
export async function escalateNotStartedSession(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  tmuxSessionName: string;
}): Promise<boolean> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return false;

  try {
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return false;

    await createComment(parsed.owner, parsed.repo, params.issueNumber, token, {
      body: buildSessionNotStartedCommentBody({
        hostName: params.hostName,
        tmuxSessionName: params.tmuxSessionName,
      }),
    });

    await addIssueLabels(parsed.owner, parsed.repo, params.issueNumber, token, [CHECK_USER_LABEL]);
    return true;
  } catch (error) {
    console.error(
      `[dispatch] セッションが開始していないことをIssueへ引き上げられませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}

/**
 * 起動確認に人が答えてClaude Codeが始まったので、上で付けた`00.check-user`を外す（#1465）。
 *
 * **外すのは自分で付けたときだけ**という約束（`session-plan.ts`）はここでも同じで、
 * 呼び出し元は`NOT_STARTED`から出る遷移でだけ呼ぶ。`NOT_STARTED`を立てたのはこの経路しか
 * 無いので、「自分で付けた」はDBの直前の値で確かめられる。
 *
 * ホスト側の印（`.check-user`）は使えない。あれはフックが置くもので、フックが1つも飛んで
 * いない状態を扱うこの経路には存在しない。
 */
export async function resolveNotStartedSession(params: {
  repositoryFullName: string;
  issueNumber: number;
}): Promise<boolean> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return false;

  try {
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return false;

    // 人が画面の承認ボタンで先に外していることもあるが、`removeIssueLabel`は404を成功として扱う
    await removeIssueLabel(parsed.owner, parsed.repo, params.issueNumber, token, CHECK_USER_LABEL);
    return true;
  } catch (error) {
    console.error(
      `[dispatch] 起動確認の00.check-userを外せませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}

/**
 * 異常終了をIssueへ知らせ、`00.check-user`を付ける。
 *
 * **失敗しても例外を投げない。** 呼び出し元（`reportDispatchSessions`）は既に状態を保存し終えており、
 * ここで落としてもpollerにできることは何も無い。成否を真偽値で返して記録だけ残す。
 */
export async function escalateFailedSession(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  tmuxSessionName: string;
  exitStatus: number | null;
}): Promise<boolean> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return false;

  try {
    // issue-deckが接続していないリポジトリではnullが返る。ホスト側では実行できても、
    // こちらから書く手段が無い
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return false;

    await createComment(parsed.owner, parsed.repo, params.issueNumber, token, {
      body: buildSessionFailedCommentBody({
        hostName: params.hostName,
        tmuxSessionName: params.tmuxSessionName,
        exitStatus: params.exitStatus,
      }),
    });

    // ラベルは**追加**する。`updateIssue`の`labels`は全置換で、既に付いている
    // `21.plan-required`・`11.local`を巻き込んで落としてしまう
    await addIssueLabels(parsed.owner, parsed.repo, params.issueNumber, token, [CHECK_USER_LABEL]);
    return true;
  } catch (error) {
    console.error(
      `[dispatch] セッションの異常終了をIssueへ引き上げられませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}
