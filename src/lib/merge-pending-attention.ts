import { filterPullRequestsByView } from "@/lib/pull-request-list";
import type { PullRequestSummary, PullRequestViewId } from "@/types/pull-request";

/**
 * 放っておけばマージされるPRか（Auto-merge有効でCIが通っている）。
 *
 * 判定をここに置いて`notifications.ts`と共有する（#2334）。ベルは元から同じ条件で
 * マージ待ちの通知からこれを除いており（`buildPullRequestNotifications`）、条件を2か所に
 * 書くと、片方だけ直された時点でベルとメニューの合図が食い違う。
 *
 * **develop向けPRでは例外ではなく通常の経路。** `claude-review-develop.yml`が自動マージ可と
 * 判定したPRは`gh pr merge --auto`でAuto-mergeが有効になるため、「マージ待ち」ビューには
 * 常時これが混ざる。
 */
export function isAutoMergingPullRequest(pullRequest: PullRequestSummary): boolean {
  return pullRequest.autoMergeEnabled && pullRequest.ciState === "success";
}

/**
 * 「マージ待ち」ビューの内訳（#2334）。
 *
 * メニューに出す**数字は`total`**（＝押した先の一覧に並ぶ件数）で、**オレンジの丸を点けるのは
 * `actionRequired`が1件以上のときだけ**。「ブランチ」の行（`ReleaseActivityCounts`）と同じ形で、
 * 数字と丸で意味が違うぶんは行の吹き出し（`describeMergePendingAttention`）で補う。
 */
export type MergePendingAttention = {
  /** 「マージ待ち」ビューに並ぶ総数 */
  total: number;
  /** 放っておけば入るもの（Auto-merge有効でCI成功） */
  autoMerging: number;
  /** CI失敗を自動修復中のもの（#2072。人ではなくエージェントが動いている） */
  repairing: number;
  /**
   * 人が手を動かすまで進まないもの。**オレンジの丸を点ける条件**——自分でマージするか、
   * CI失敗を直すかしかないPR。
   */
  actionRequired: number;
};

/**
 * 「マージ待ち」ビューの内訳を数える（#2334）。
 *
 * **母集団は`filterPullRequestsByView(_, "completed")`そのもの**で、`computePullRequestNavCounts`が
 * 数える`completed`と必ず一致する（`total`がメニューの数字と食い違うと、丸の中の数字が
 * 別の数え方になる）。渡す一覧も呼び出し側で揃える。
 *
 * **丸から外すのは「人が動かなくても進むもの」2つだけ。** Auto-merge有効でCI成功
 * （`isAutoMergingPullRequest`。GitHubが入れる）と、CI失敗の自動修復中（#2072。エージェントが
 * 直しにいっている）。どちらもベルが同じ理由で通知の強さを落としている。**CI失敗で修復が
 * 走っていないものは外さない**——待っても解消せず人が直すしかない。
 *
 * **未取得（`loaded`がfalse）は`null`**。件数と同じ作法で、取得前に0を出して「手を動かす
 * ものが無い」と読ませない。
 */
export function countMergePendingAttention(
  pullRequests: PullRequestSummary[],
  loaded: boolean,
): MergePendingAttention | null {
  if (!loaded) return null;

  const mergePending = filterPullRequestsByView(pullRequests, "completed");
  const autoMerging = mergePending.filter(isAutoMergingPullRequest);
  const repairing = mergePending.filter(
    (pullRequest) => !isAutoMergingPullRequest(pullRequest) && pullRequest.repairRun !== null,
  );

  return {
    total: mergePending.length,
    autoMerging: autoMerging.length,
    repairing: repairing.length,
    actionRequired: mergePending.length - autoMerging.length - repairing.length,
  };
}

/**
 * その行の件数をオレンジの丸（`NavCount`の`emphasis="attention"`）で出すか（#2334）。
 *
 * **点けるのは「マージ待ち」の行だけ、それも人が動くまで進まないPRが残っているとき。**
 * 「すべてのPR」は実行中を含む在庫の数、「実行中」はCI・判定の結果待ちで人が何もしなくても
 * 進むものなので点けない。0件・未取得でも点けない——丸は「いま手を動かせるものがある」という
 * 合図で、`0`に丸を付けると合図として読めなくなる。
 *
 * **判定をここに置いて画面側に書かない。** PCの左メニュー・スマホのホーム・スマホのビュー選択
 * シートの3か所に同じ条件が散ると、片方だけ直された時点でPCとスマホで意味が食い違う
 * （`resolveQuestionNavSignals`と同じ置き方）。
 */
export function isPullRequestViewAttention(
  id: PullRequestViewId,
  attention: MergePendingAttention | null,
): boolean {
  return id === "completed" && (attention?.actionRequired ?? 0) > 0;
}

/**
 * 「マージ待ち」の行に添える文言（`title`）。
 *
 * **数字（一覧に並ぶ総数）と丸（人が動くまで進まないものがあるという合図）で意味が違う**ため、
 * 行のラベルからは何を数えているのか読めない。内訳をここで補う（「ブランチ」の行の
 * `describeReleaseActivity`、「質問」の行の`formatQuestionNavTitle`と同じ考え方）。
 *
 * **「要操作」と「自動で進むもの」を書き分ける。** まとめて「マージ待ち3件」とだけ書くと、
 * 丸が点いていない理由（3件ともGitHubが入れる／エージェントが直している）を読めない。
 */
export function describeMergePendingAttention(
  description: string,
  attention: MergePendingAttention | null,
): string {
  if (attention === null || attention.total === 0) return description;

  const breakdown = [
    attention.actionRequired > 0 ? `要操作${attention.actionRequired}件` : null,
    attention.autoMerging > 0 ? `自動マージ待ち${attention.autoMerging}件` : null,
    attention.repairing > 0 ? `自動修復中${attention.repairing}件` : null,
  ]
    .filter((part) => part !== null)
    .join("・");

  return `${description}（${attention.total}件: ${breakdown}）`;
}
