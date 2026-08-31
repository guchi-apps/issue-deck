import {
  addCheckUserWithReason,
  removeCheckUserWithReason,
} from "@/lib/dispatch/check-user-labels";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { createComment } from "@/lib/github/issues-api";
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

/** APIエラーで中断したまま止まっていることを知らせたマーカー（#1971） */
const SESSION_INTERRUPTED_MARKER = "<!-- supervisor:session-interrupted -->";

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
    "**答えても何も始まらない場合**は、同じペインの上の方に出ている「セッションへ次の文面を渡します」の文面を貼り付けてください（信頼確認の承認で、起動時に渡したプロンプトが失われることがあります）。",
    "",
    "### 次から出ないようにする",
    "",
    "信頼確認は**リポジトリにつき1回**です。答えた記録は本体チェックアウトのパスに残り、そのリポジトリのworktreeでは以後聞かれません。",
    "新しいリポジトリを対象に加えたときは、セッションを起こす前に端末で一度だけ答えておけば、この足止めは起きません。",
    "",
    "```bash",
    "cd <本体チェックアウトのパス> && claude   # 「Yes, I trust this folder」を選び、/exit で抜ける",
    "```",
    "",
    SESSION_NOT_STARTED_MARKER,
  ].join("\n");
}

/**
 * Claude Codeが開始しないまま止まっていることをIssueへ知らせ、`00.check-user`と理由ラベル
 * `01.check-blocked`を付ける（#1465・#1490）。
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

    await addCheckUserWithReason(parsed.owner, parsed.repo, params.issueNumber, token, "blocked");
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
 * 起動確認に人が答えてClaude Codeが始まったので、上で付けた`00.check-user`を理由ラベルごと
 * 外す（#1465・#1490）。
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
    await removeCheckUserWithReason(parsed.owner, parsed.repo, params.issueNumber, token);
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
 * 異常終了をIssueへ知らせ、`00.check-user`と理由ラベル`01.check-blocked`を付ける（#1490）。
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
    await addCheckUserWithReason(parsed.owner, parsed.repo, params.issueNumber, token, "blocked");
    return true;
  } catch (error) {
    console.error(
      `[dispatch] セッションの異常終了をIssueへ引き上げられませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}

/**
 * セッションが中断・停滞して止まっていることをIssueへ知らせる本文（#1971・#2280・#2655）。
 *
 * **`detail`はpollerが組み立てた固定の文言だけ**（何回試して諦めたか、など）。セッションの
 * 画面も応答テキストも載せない——`escalateFailedSession`と同じ約束で、見に行く経路は
 * `tmux attach`とRemote Controlのリンクにする。
 *
 * `reason`は引き上げの原因（省略時`"api_error"`）。原因ごとに何が起きたかの説明だけを
 * 出し分け、ホスト・tmuxセッション・状況・出口の構造は共通にする。
 */
export function buildSessionInterruptedCommentBody(params: {
  hostName: string;
  tmuxSessionName: string;
  detail: string | null;
  remoteControlUrl: string | null;
  reason?: "api_error" | "tool_call_stall";
}): string {
  const reason = params.reason ?? "api_error";
  const lines =
    reason === "tool_call_stall"
      ? [
          "⚠️ このIssueの実装セッションが、ツールを呼び出そうとした形跡はあるものの、実際には",
          "呼び出されないまま停滞しています。",
        ]
      : ["⚠️ このIssueの実装セッションが、APIエラーで中断したまま止まっています。"];
  lines.push(
    "",
    `- ホスト: \`${params.hostName}\``,
    `- tmuxセッション: \`${params.tmuxSessionName}\``,
  );
  if (params.detail) lines.push(`- 状況: ${params.detail}`);
  lines.push("");
  if (reason === "tool_call_stall") {
    lines.push(
      "Claude Codeが直前の応答でツール（`Agent`など）を呼び出すつもりで、実際にはtool_useとして",
      "呼び出さずコード風の**テキスト**を出力するだけでターンを終える、という誤動作が起きた",
      "可能性があります。この場合`Stop`フックは正常に発火するため、issue-deckの画面からは",
      "「正常に応答した」ように見えます。固定文言の再送信では確実に復旧しないことを確認して",
      "いるため、pollerは自動では再送信していません。",
    );
  } else {
    lines.push(
      "Claude CodeがAPIの一時エラー（529 Overloaded など）を再試行しきるとturnが打ち切られ、",
      "**`Stop`フックが飛ばないまま**セッションが入力欄で止まります。pollerが固定の1行を送って",
      "自動再開を試みましたが、上限回数まで復帰しませんでした（`scripts/lib/session-resume.sh`）。",
    );
  }
  lines.push(
    "",
    "続きは人が指示してください。端末から続けるか、",
    "",
    "```bash",
    `tmux attach -t ${params.tmuxSessionName}`,
    "```",
  );
  if (params.remoteControlUrl) {
    lines.push("", `Remote Controlから続けてください: ${params.remoteControlUrl}`);
  }
  lines.push(
    "",
    "セッションが動き出しても、この`00.check-user`は自動では外れません（人が続け方を決めたこと",
    "自体が合図なので、画面の承認ボタンか`gh issue edit`で外してください）。",
    "",
    SESSION_INTERRUPTED_MARKER,
  );
  return lines.join("\n");
}

/**
 * APIエラーで中断したセッションをIssueへ引き上げ、`00.check-user`と理由ラベル
 * `01.check-blocked`を付ける（#1971・#2280）。
 *
 * **#2280より前はSignalyへ通知するだけだった。** webhookを消したので、`escalateFailedSession`と
 * 同じ形（Issueコメント＋`01.check-blocked`）へ寄せた。理由が`input`ではなく`blocked`なのは、
 * ユーザーがやることが「回答」ではなく**続け方の指示**だから（CLAUDE.mdの理由ラベルの定義）。
 *
 * 呼ぶのはサブPCのpollerが合成する`SessionInterrupted`を受けた
 * `POST /api/dispatch/sessions/interrupted`で、**1セッションにつき1回**
 * （送ったかどうかの記録はホスト側の`.resume`・`.tool-call-stall`が持つ）。
 *
 * `reason`は引き上げの原因（省略時`"api_error"`。#2655で`"tool_call_stall"`を追加）。
 *
 * **失敗しても例外を投げない**（`escalateFailedSession`と同じ）。
 */
export async function escalateInterruptedSession(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  tmuxSessionName: string;
  detail: string | null;
  remoteControlUrl: string | null;
  reason?: "api_error" | "tool_call_stall";
}): Promise<boolean> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return false;

  try {
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return false;

    await createComment(parsed.owner, parsed.repo, params.issueNumber, token, {
      body: buildSessionInterruptedCommentBody({
        hostName: params.hostName,
        tmuxSessionName: params.tmuxSessionName,
        detail: params.detail,
        remoteControlUrl: params.remoteControlUrl,
        reason: params.reason,
      }),
    });

    await addCheckUserWithReason(parsed.owner, parsed.repo, params.issueNumber, token, "blocked");
    return true;
  } catch (error) {
    console.error(
      `[dispatch] セッションの中断をIssueへ引き上げられませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}
