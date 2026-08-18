import {
  CHECK_USER_LABEL,
  CHECK_USER_REASON_LABELS,
  checkUserReason,
  isCheckUserReasonLabel,
  isSessionRemovableCheckUserReason,
  type CheckUserReason,
} from "@/lib/github/approval-labels";
import {
  addIssueLabels,
  fetchIssueLabelNames,
  fetchRepositoryLabelNames,
  removeIssueLabel,
} from "@/lib/github/issues-api";

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
 *
 * **付与後のラベル名を返す**（#1855）。呼び出し側（`postSessionPlan`）は「このIssueに
 * `21.plan-required`が付いているか」で計画レビューを起こすかどうかを決めるが、そのために
 * GitHubへもう一度問い合わせる必要は無い——ここで既に分かっている。返すのは
 * `00.check-user`の付与直後の一覧で、**この後に外す理由ラベルは含まれうる**（判定に使うのは
 * それ以外のラベルなので、区別する必要は無い）。取れなければ`null`。
 *
 * `keepExistingReasons`を渡すと、**そこに挙げた理由が既に付いている場合は付け替えない**
 * （#1905）。計画を出した直後に承認プロンプトの`Notification`が飛び、9秒後に
 * `01.check-plan`が`01.check-input`へ落ちていた——画面の見出しが「計画の承認が必要です」
 * から「質問への回答が必要です」に変わり、何を待たれているのかが読めなくなる。
 */
export async function addCheckUserWithReason(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  reason: CheckUserReason,
  options?: { keepExistingReasons?: readonly CheckUserReason[] },
): Promise<string[] | null> {
  const currentNames = await addIssueLabels(owner, repo, issueNumber, token, [CHECK_USER_LABEL]);

  const keptLabels = (options?.keepExistingReasons ?? []).map(
    (kept) => CHECK_USER_REASON_LABELS[kept],
  );
  // 既に付いている理由の方が具体的なら、そのままにする（#1905）
  if (keptLabels.some((label) => currentNames.includes(label))) return currentNames;

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
    return currentNames;
  }

  if (definedLabels.has(reasonLabel) && !currentNames.includes(reasonLabel)) {
    await addIssueLabels(owner, repo, issueNumber, token, [reasonLabel]);
  }
  for (const stale of staleReasonLabels) {
    await removeIssueLabel(owner, repo, issueNumber, token, stale);
  }
  return currentNames;
}

/**
 * 自分で付けた`00.check-user`を、理由ラベルごと外す（#1490）。
 *
 * **外すのは`00.check-user`を外すのと同じ場所**という約束の、ローカルセッション側の実装。
 * 残っている理由ラベルは`removeIssueLabel`の戻り値（除去後のラベル一覧）から分かるので、
 * 実際に付いているものだけを外す。`00.check-user`が既に外れていた（404）場合は、人が画面の
 * 承認ボタンで先に外した場合であり、その経路（`labelsAfterApproval`）が理由ラベルも一緒に
 * 落としているため何もしない。
 *
 * **外す前に、いま付いている理由を読んで自分のものか確かめる**（#1905）。ホスト側の印
 * （`scripts/lib/session-state.sh`の`.check-user`）はセッションをまたいで引き継がれるように
 * なったため、「自分が付けた」と言えるのは印が置かれた時点までで、その後に別の実行体が
 * `01.check-merge`（レビュー・統合）や`01.check-answered`（無人実行）へ付け替えている
 * ことがある。そこまで落とすと、人はマージ・確認の合図を失う。
 */
export async function removeCheckUserWithReason(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<void> {
  if (!(await isRemovableBySession(owner, repo, issueNumber, token))) return;

  const remaining = await removeIssueLabel(owner, repo, issueNumber, token, CHECK_USER_LABEL);
  if (remaining === null) return;
  for (const name of remaining.filter(isCheckUserReasonLabel)) {
    await removeIssueLabel(owner, repo, issueNumber, token, name);
  }
}

/**
 * いま付いている`00.check-user`が、ローカルセッションの経路で外してよいものか（#1905）。
 *
 * **ラベルを読めなかったときは外す側に倒す。** ここで止めると、読み取りが失敗している間ずっと
 * 確認待ちが解けなくなる（実際に困るのは#1905の症状そのもの）。誤って外しても人は画面から
 * 付け直せるが、外れないままだと画面には「実行中なのに確認待ち」しか残らない。
 */
async function isRemovableBySession(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<boolean> {
  let names: string[];
  try {
    names = await fetchIssueLabelNames(owner, repo, issueNumber, token);
  } catch (error) {
    console.error(
      `[dispatch] ラベルを取得できませんでした（${owner}/${repo}#${issueNumber}）`,
      error,
    );
    return true;
  }
  return isSessionRemovableCheckUserReason(checkUserReason(names.map((name) => ({ name }))));
}
