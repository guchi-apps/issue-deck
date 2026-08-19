import { isSessionWaitingInput } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import {
  checkUserReason,
  isApprovalPending,
  isSessionRemovableCheckUserReason,
} from "@/lib/github/approval-labels";
import type { IssueLabel } from "@/types/issue";

/**
 * Issue一覧のRemote Controlのボタンを強調するか（#1964）。
 *
 * 一覧のRemoteボタン（#1915）は**セッションが生きている行にはすべて同じ枠線で出る**ため、
 * 「押さないと先へ進まない行」と「見に行けるだけの行」が同じ見た目になっていた。確認待ちの
 * ビューを開いても、どれから触ればよいかは行を開くまで分からない。
 *
 * **判定はここ1か所に置く。** 出す・出さないの条件（`summarizeIssueSession`のURL）と、
 * 強調する・しないの条件は別のものなので、ボタンの側で両方を組み立てると片方だけ古くなる。
 *
 * 条件は`resolveCheckUserGuidance`（`check-user-guidance.ts`）が
 * `action.kind === "remote-control"`を返す場面と同じ考え方で揃えてある。あちらはIssue詳細で
 * 「次にどこを押すか」を1つ選ぶもので、こちらは一覧で「押す場所がRemote Controlか」だけを見る。
 */
export function shouldEmphasizeRemoteControl({
  labels,
  session,
}: {
  labels: readonly Pick<IssueLabel, "name">[];
  /** そのIssueのセッション（`findSessionForIssue`の結果）。無ければnull */
  session: DispatchSessionView | null;
}): boolean {
  // セッションが質問・承認プロンプトの前で止まっている。答える先はRemote Controlしかない
  if (isSessionWaitingInput(session)) return true;
  if (!isApprovalPending(labels)) return false;
  // **理由がセッション自身の付けたものであるときだけ強調する。** `01.check-merge`（レビュー・
  // 統合が付ける）は画面の対応PRから、`01.check-answered`（無人実行が付ける）はコメント欄の
  // 「確認待ちを外す」から片付くもので、どちらもRemote Controlの出番ではない。集合は
  // `isSessionRemovableCheckUserReason`（#1905）を借りる——**セッションが付けた理由なら、
  // 待っているのもそのセッション**なので、フックが外してよい理由と答える先は一致する。
  // 理由ラベルが配られていないリポジトリでは`null`になり、そこでは強調する側に倒す（何を
  // 待っているかは読めないが、`00.check-user`が付いている以上待っているのは確かなため）。
  return isSessionRemovableCheckUserReason(checkUserReason(labels));
}
