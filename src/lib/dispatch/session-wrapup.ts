import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { SESSION_STARTED_MARKER } from "@/lib/dispatch/session-start";
import { formatDuration } from "@/lib/format-duration";
import { createComment, fetchCommentsForIssue, type GithubApiComment } from "@/lib/github/issues-api";
import { parseRepositoryFullName } from "@/lib/local-session";

/**
 * 何も記録を残さずに終わったローカルセッションをIssueへ書き残す（#1119）。
 *
 * GitHub Actionsの無人実行では、実装ステップが落ちてもワークフローのフォールバック通知が
 * 必ず出る。ローカルセッションで自動的に出るのは異常終了の引き上げ（#1217・
 * `session-escalation.ts`）だけで、**正常に終了したのに何も投稿しなかった場合**は拾えない。
 * 完了報告はプロンプトの指示、つまりエージェントが従うかどうかに依存していて担保が無い
 * （#1342で計画に同じ問題があったのと同じ構図）。
 *
 * そこでセッションが消えた時点で、そのセッションの間にIssueへ何か残ったかを見て、
 * 何も無ければ締めのコメントを書く。
 *
 * **`00.check-user`は付けない。** ローカルは人が横にいる前提で、意図的に畳んだだけで
 * 要確認バッジが立つのは過剰。人の判断が要る異常終了は#1217が`00.check-user`込みで拾うため、
 * ここを外しても穴にはならない。
 */

/** 自動投稿された締めコメントであることを示すマーカー */
export const SESSION_WRAPUP_MARKER = "<!-- issue-deck:session-wrapup -->";

/**
 * 「記録が残っている」とみなすマーカー。**前方一致で見る**（`issue-deck-agent:implementer`・
 * `issue-deck-source:issue-labels`のように役割・投稿元が増えても追随させないため）。
 *
 * 人が書いたコメント（マーカーの無いもの）は数えない。ここで見たいのは**セッションが何をしたか**で、
 * `11.local`が付いている間、人のコメントはそもそもセッションに届かない（#1287）。
 */
const RECORD_MARKER_PREFIXES = [
  // エージェントが手で投稿したもの（計画・完了報告・判断の記録・中断の報告）
  "<!-- issue-deck-agent:",
  // 計画の自動投稿（#1342）。役割マーカーを持たないので別に見る
  "<!-- issue-deck:session-plan -->",
  // ワークフローからの投稿（PR作成・developへのマージ・共有知識の提案など）
  "<!-- issue-deck-source:",
  // 異常終了の引き上げ（#1217）・計画へのレビュー指摘
  "<!-- supervisor:",
  // 自分自身。2つの呼び出し経路から重複して呼ばれても投稿を1回に留めるための鍵
  SESSION_WRAPUP_MARKER,
];

/**
 * どの時点から後のコメントを「このセッションの記録」とみなすか。
 *
 * **受付コメント（#1119）の投稿時刻を基準にする。** あれは`claude`の起動直前に投稿されるので、
 * セッションの開始そのものを指す。`DispatchSession.firstSeenAt`はpollerが最初に見た時刻で、
 * 起動から最大1巡（既定60秒）遅れる。その差の間に計画が出ると「記録なし」と誤判定するため、
 * 受付コメントがあればそちらを優先し、無ければ`firstSeenAt`へ落とす。
 */
export function resolveSessionRecordSince(
  comments: GithubApiComment[],
  fallback: Date,
): Date {
  let latest: number | null = null;
  for (const comment of comments) {
    if (!comment.body?.includes(SESSION_STARTED_MARKER)) continue;
    const at = new Date(comment.created_at).getTime();
    if (Number.isNaN(at)) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest === null ? fallback : new Date(latest);
}

/**
 * `since`以降にセッション由来の記録が残っているか。
 *
 * **受付コメント自体は数えない。** あれはこの仕組みが出したもので、セッションが何かをした
 * 証拠にはならない。
 */
export function hasIssueRecordSince(comments: GithubApiComment[], since: Date): boolean {
  const from = since.getTime();
  return comments.some((comment) => {
    const body = comment.body;
    if (!body) return false;
    if (body.includes(SESSION_STARTED_MARKER)) return false;
    const at = new Date(comment.created_at).getTime();
    if (Number.isNaN(at) || at < from) return false;
    return RECORD_MARKER_PREFIXES.some((marker) => body.includes(marker));
  });
}

export function buildSessionWrapupCommentBody(params: {
  hostName: string;
  tmuxSessionName: string;
  issueNumber: number;
  /** セッションの稼働時間。基準時刻が取れなければ省く */
  elapsedMs: number | null;
}): string {
  const where = formatDispatchHostName(params.hostName);

  const lines = [
    `⚠️ **${where}のローカルセッションが終了しましたが、このIssueには記録が残っていません。**`,
    "",
    `- ホスト: \`${params.hostName}\``,
    `- tmuxセッション: \`${params.tmuxSessionName}\``,
  ];
  if (params.elapsedMs !== null) {
    lines.push(`- 稼働時間: ${formatDuration(params.elapsedMs)}`);
  }
  lines.push(
    "",
    "計画・完了報告・PRのいずれも投稿されていないため、作業が途中で止まっている可能性があります。続きから再開する場合は、worktreeを作り直さずに次のコマンドで起こせます。",
    "",
    "```bash",
    `scripts/start-issue.sh ${params.issueNumber}`,
    "```",
    "",
    SESSION_WRAPUP_MARKER,
    // 受付コメントと同じ案内ボット名義にする。作業の報告ではなく、状態の案内なので
    "<!-- issue-deck-agent:guide -->",
  );
  return lines.join("\n");
}

/**
 * セッションの終了を締めるコメントを、記録が何も無いときだけ投稿する。
 *
 * **失敗しても例外を投げない。** 呼び出し元（`markDispatchSessionEnded`・
 * `reportDispatchSessions`）は既に状態を保存し終えており、ここで落としても
 * ホスト側にできることは何も無い（`session-escalation.ts`と同じ扱い）。
 *
 * 呼び出し経路は`trap`（`POST /api/dispatch/sessions/ended`）とpollerの巡回の2つあり、
 * どちらも同じセッションについて呼びうる。**重複はDBの列ではなく、自分のマーカーを
 * 「記録あり」に数えることで防ぐ**（マイグレーションを伴わずに済ませるため）。
 */
export async function postSessionWrapupComment(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  tmuxSessionName: string;
  /** `DispatchSession.firstSeenAt`。受付コメントが見つからなかったときの基準になる */
  firstSeenAt: Date;
  now?: Date;
}): Promise<boolean> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return false;

  try {
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return false;

    const comments = await fetchCommentsForIssue(
      parsed.owner,
      parsed.repo,
      params.issueNumber,
      token,
    );
    const since = resolveSessionRecordSince(comments, params.firstSeenAt);
    if (hasIssueRecordSince(comments, since)) return false;

    const now = params.now ?? new Date();
    await createComment(parsed.owner, parsed.repo, params.issueNumber, token, {
      body: buildSessionWrapupCommentBody({
        hostName: params.hostName,
        tmuxSessionName: params.tmuxSessionName,
        issueNumber: params.issueNumber,
        elapsedMs: Math.max(0, now.getTime() - since.getTime()),
      }),
    });
    return true;
  } catch (error) {
    console.error(
      `[dispatch] セッションの締めコメントをIssueへ投稿できませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}
