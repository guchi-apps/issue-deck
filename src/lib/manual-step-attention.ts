import { isManualStepIssue } from "@/lib/github/approval-labels";
import {
  extractManualStepReferences,
  resolveManualStepPrerequisites,
} from "@/lib/manual-step-prerequisites";
import type { Issue } from "@/types/issue";

/** 左メニュー「ユーザーの作業待ち」の内訳（#1613） */
export type ManualStepAttention = {
  /** openな手作業Issueの件数（左メニューに出す数） */
  total: number;
  /** そのうち、いま実行できるもの */
  actionable: number;
  /** そのうち、先に完了している必要があるIssue・PRが残っていて実行できないもの */
  waitingForPrerequisites: number;
};

/**
 * 手作業Issue（`71.manual-step`）を「いま実行できるもの」と「前提待ちのもの」に分ける（#1613）。
 *
 * 手作業Issueの多くは、先に完了しているべき変更が**本番へ出た後**でなければ実行できない
 * （本番サーバーの`.env`を書き換える、デプロイ済みの画面で設定する、など）。左メニューを
 * 1件でもあれば強調するままにすると、数週間先まで実行できない手作業が残っている間ずっと
 * 橙色が点いたままになり、「いま手を動かせば盤面が進む」という合図として読めなくなる。
 *
 * 判定は本文に書かれた参照の進捗で行う。手作業Issueの`## 前提条件`と`## 関連`から番号を読み
 * （`manual-step-prerequisites.ts`）、同じ一覧のIssueから引く。1件でも「まだ待っている」状態
 * （developまで・実装中・マージ待ち）が残っていれば、その手作業は前提待ちとみなす。
 * **Issue詳細の「前提条件の状況」（#1705）と同じ計算**なので、左メニューの数と詳細の判定が
 * 食い違わない。違うのはPRの参照だけで、ここでは追加取得をしないぶん「状態不明」となり、
 * 下記のとおり待ちには数えない。
 *
 * **状態を特定できない参照は「実行できる」側に数える。** 記載が無い・一覧に載っていない
 * （別リポジトリや取得範囲外）というだけで待ち扱いにすると、実行できる手作業を見落とすため。
 * 強調しすぎて損をする方向へ倒す。
 *
 * @param issues 左メニューの絞り込み（リポジトリなど）を適用したあとのIssue一覧
 * @param referenceIssues 参照先を引くための母集団。省略時は`issues`と同じ
 */
export function computeManualStepAttention(
  issues: Issue[],
  referenceIssues: Issue[] = issues,
): ManualStepAttention {
  let actionable = 0;
  let waitingForPrerequisites = 0;
  for (const issue of issues) {
    if (issue.state !== "open" || !isManualStepIssue(issue.labels)) continue;
    const references = extractManualStepReferences(
      issue.body,
      issue.repositoryFullName,
      issue.number,
    );
    const prerequisites = resolveManualStepPrerequisites(
      references,
      referenceIssues,
      [],
      issue.repositoryFullName,
    );
    if (prerequisites.some((prerequisite) => !prerequisite.satisfied)) {
      waitingForPrerequisites += 1;
    } else {
      actionable += 1;
    }
  }

  return { total: actionable + waitingForPrerequisites, actionable, waitingForPrerequisites };
}
