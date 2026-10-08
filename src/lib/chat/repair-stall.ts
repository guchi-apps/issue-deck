/**
 * 同じ理由で止まり続けている自動修正を検出する（#4153）。
 *
 * #4142では、自動修正が3回とも「途中PRか最終PRかの方針回答待ち」で止まり、コードもHEADも
 * 変わらないまま4回目を起動できてしまう形だった。実行系（実装エージェント）の停止報告が
 * 続いており、その後に**利用者が承認した修正依頼**（`issue-deck-chat-fix-request`の印）も
 * 方針を記録するIssueコメントも無いときは、同じ自動修正を再起動しても進展しない。
 */

const AGENT_REPORT_MARKER = "issue-deck-agent:implementer";
const FIX_REQUEST_MARKER = "issue-deck-chat-fix-request";
/** 停止報告が「利用者の判断待ち」であることを示す言い回し */
const WAITING_WORDS = /(方針|判断|選択|どちら|どっち).{0,40}(回答|待ち|確認|お願い|ください|決め)|(回答|返答|判断).{0,20}(待ち|お願い)|途中PR.{0,20}最終PR|最終PR.{0,20}途中PR/;
/** 停止の報告として扱う上限件数（これ以上は同じ停止の繰り返しとみなす） */
export const REPAIR_STALL_LIMIT = 3;

export type StallComment = { body: string | null; created_at: string };

export type RepairStall = { stalled: boolean; consecutive: number; lastReportAt: string | null };

/**
 * コメントを新しい順に読み、利用者が承認した修正依頼が現れるまでの、判断待ちの停止報告を数える。
 * 実行系の報告でもチャットの修正依頼でもないコメント（人の返信など）は数えずに読み飛ばす。
 */
export function detectRepairStall(comments: StallComment[]): RepairStall {
  const sorted = [...comments].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  let consecutive = 0;
  let lastReportAt: string | null = null;
  for (const comment of sorted) {
    const body = comment.body ?? "";
    if (body.includes(FIX_REQUEST_MARKER)) break;
    if (!body.includes(AGENT_REPORT_MARKER)) continue;
    if (!WAITING_WORDS.test(body)) break;
    consecutive += 1;
    lastReportAt ??= comment.created_at;
  }
  return { stalled: consecutive >= REPAIR_STALL_LIMIT, consecutive, lastReportAt };
}
