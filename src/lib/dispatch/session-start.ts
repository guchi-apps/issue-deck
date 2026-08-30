import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import type { DispatchAgent } from "@/lib/dispatch/dispatch-job";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { createComment } from "@/lib/github/issues-api";
import { parseRepositoryFullName } from "@/lib/local-session";

/**
 * ローカルの実装セッションが起動したことをIssueへ残す（#1119）。
 *
 * **GitHub Actionsの無人実行には受付コメントがある**（#75）。モード判定の直後に、後続の
 * Claude Codeステップとは独立した単純なシェルステップが「依頼を確認し対応を開始する」旨を
 * 投稿する。エージェント自身に委ねると、調査に時間がかかった場合や途中で行き詰まった場合に
 * 「依頼を受け取ったこと」自体が伝わらないためである。
 *
 * ローカルセッションにはこれが無かった。起動してからエージェントが最初の投稿をするまで
 * （`21.plan-required`なら計画が出るまで、そうでなければPRができるまで）、Issueの画面には
 * 何も出ない。Actions UIに相当する実行ログもサブPCには無いので、外から見ると「押したのに
 * 何も起きていない」と区別が付かない。
 *
 * そこで`scripts/run-issue-session.sh`が`claude`の起動直前に1回だけ叩き、ここが
 * GitHub App名義で書く。経路は計画の投稿（`session-plan.ts`）・異常終了の引き上げ
 * （`session-escalation.ts`）と同じで、**サブPCにGitHubの認証を持たせない**ため。
 *
 * **重複は抑止しない。** 1起動につき1件で、Actionsもdispatchのたびに受付を出すので挙動が揃う。
 * 同じIssueで起こし直したことがコメントの並びから分かる方が、追う側にとって都合がよい。
 */

/** 自動投稿された受付コメントであることを示すマーカー */
export const SESSION_STARTED_MARKER = "<!-- issue-deck:session-started -->";

/**
 * 役割の表示は`guide`（案内ボット）にする。**Actionsの受付コメントと揃える**（#860）。
 * 受付はモードによらず案内であって、実装作業そのものの報告ではない。
 */
const AGENT_ROLE_MARKER = "<!-- issue-deck-agent:guide -->";

export function buildSessionStartedCommentBody(params: {
  hostName: string;
  tmuxSessionName: string;
  agent?: DispatchAgent;
  model?: string | null;
}): string {
  const where = formatDispatchHostName(params.hostName);
  const agent = params.agent ?? "claude";
  const agentName = agent === "codex" ? "Codex CLI" : "Claude Code";
  const model = !params.model || params.model === "auto" ? "CLIの既定" : params.model;
  const instructionGuide =
    agent === "codex"
      ? "`11.local`が付いている間、このコメント欄へ書いても走っているセッションには届きません。追加の指示は端末から伝えてください。"
      : "`11.local`が付いている間、このコメント欄へ書いても走っているセッションには届きません。追加の指示はRemote Controlか端末から伝えてください。";

  return [
    `🖥️ **${where}のローカルセッションで対応を開始します。**`,
    "",
    `- ホスト: \`${params.hostName}\``,
    `- tmuxセッション: \`${params.tmuxSessionName}\``,
    `- エージェント: ${agentName}`,
    `- モデル: \`${model}\``,
    "",
    // **Actions UIに相当するものがローカルには無い**（このIssueの出発点）。実行の様子を
    // 見に行ける先を、受付の時点で必ず書いておく。承認待ちになればRemote Controlのリンクが
    // 別コメント（計画・#1342）で載るが、そこまで待たずに追える口が要る。
    "実行の様子はGitHub Actionsのようにログとしては残りません。次のコマンドで様子を見られます。",
    "",
    "```bash",
    `tmux attach -t ${params.tmuxSessionName}`,
    "```",
    "",
    instructionGuide,
    "",
    SESSION_STARTED_MARKER,
    AGENT_ROLE_MARKER,
  ].join("\n");
}

/**
 * 受付コメントをIssueへ投稿する。
 *
 * **失敗しても例外を投げない。** 呼び出し元はセッションの起動直前で、失敗したからといって
 * 起動を止める理由にはならない（`run-issue-session.sh`側も報告の失敗でセッションを止めない）。
 *
 * **ラベルには触らない。** 受付は状態の変化ではなく記録で、`00.check-user`のような
 * 人の操作を待つ合図ではない。
 */
export async function postSessionStartedComment(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  tmuxSessionName: string;
  agent?: DispatchAgent;
  model?: string | null;
}): Promise<boolean> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return false;

  try {
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return false;

    await createComment(parsed.owner, parsed.repo, params.issueNumber, token, {
      body: buildSessionStartedCommentBody({
        hostName: params.hostName,
        tmuxSessionName: params.tmuxSessionName,
        agent: params.agent,
        model: params.model,
      }),
    });
    return true;
  } catch (error) {
    console.error(
      `[dispatch] セッションの受付コメントをIssueへ投稿できませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}
