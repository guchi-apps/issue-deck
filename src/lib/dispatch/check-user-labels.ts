import {
  CHECK_USER_LABEL,
  CHECK_USER_REASON_LABELS,
  isCheckUserReasonLabel,
  type CheckUserReason,
} from "@/lib/github/approval-labels";
import { addIssueLabels, fetchRepositoryLabelNames, removeIssueLabel } from "@/lib/github/issues-api";

/**
 * ローカルセッションの経路から`00.check-user`を、理由（`01.check-*`）付きで付ける（#1490）。
 *
 * 守っている約束は3つ。
 *
 * - **`00.check-user`を先に、単独で付ける。** 理由ラベルは補助でしかないので、その付与が
 *   失敗しても`00.check-user`を巻き添えにしない。**理由ラベルが無くても従来どおり動く。**
 * - **リポジトリに定義されていない理由ラベルは付けない。** 付与エンドポイントは存在しない
 *   ラベル名をその場で作ってしまうため、ガードが無いと配布前のリポジトリに色も説明も無い
 *   ラベルが生える。無人実行のワークフローの`gh label list | grep -qx`（#975）と同じ扱いにする。
 * - **理由は常に1枚。** 既に付いている別の理由ラベル（旧名`00.qa-answered`を含む）を外す。
 *   何が付いているかは`addIssueLabels`の戻り値（付与後のラベル一覧）から分かるので、
 *   そのための追加のAPI呼び出しは要らない。
 */
export async function addCheckUserWithReason(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  reason: CheckUserReason,
): Promise<void> {
  const currentNames = await addIssueLabels(owner, repo, issueNumber, token, [CHECK_USER_LABEL]);

  const reasonLabel = CHECK_USER_REASON_LABELS[reason];
  const staleReasonLabels = currentNames.filter(
    (name) => isCheckUserReasonLabel(name) && name !== reasonLabel,
  );

  let definedLabels: Set<string>;
  try {
    definedLabels = await fetchRepositoryLabelNames(owner, repo, token);
  } catch (error) {
    // 理由ラベルは補助でしかない。ここで失敗しても`00.check-user`は既に付いており、画面は
    // 従来どおりの推測で動く
    console.error(`[dispatch] ラベル一覧を取得できませんでした（${owner}/${repo}）`, error);
    return;
  }

  if (definedLabels.has(reasonLabel) && !currentNames.includes(reasonLabel)) {
    await addIssueLabels(owner, repo, issueNumber, token, [reasonLabel]);
  }
  for (const stale of staleReasonLabels) {
    await removeIssueLabel(owner, repo, issueNumber, token, stale);
  }
}

/**
 * 自分で付けた`00.check-user`を、理由ラベルごと外す（#1490）。
 *
 * **外すのは`00.check-user`を外すのと同じ場所**という約束の、ローカルセッション側の実装。
 * 残っている理由ラベルは`removeIssueLabel`の戻り値（除去後のラベル一覧）から分かるので、
 * 実際に付いているものだけを外す。`00.check-user`が既に外れていた（404）場合は、人が画面の
 * 承認ボタンで先に外した場合であり、その経路（`labelsAfterApproval`）が理由ラベルも一緒に
 * 落としているため何もしない。
 */
export async function removeCheckUserWithReason(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<void> {
  const remaining = await removeIssueLabel(owner, repo, issueNumber, token, CHECK_USER_LABEL);
  if (remaining === null) return;
  for (const name of remaining.filter(isCheckUserReasonLabel)) {
    await removeIssueLabel(owner, repo, issueNumber, token, name);
  }
}
