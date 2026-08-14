import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { addIssueLabels, createComment } from "@/lib/github/issues-api";
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
