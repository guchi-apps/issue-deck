import { extractManualStepOrigin } from "@/lib/branch-flow";
import { isManualStepIssue } from "@/lib/github/approval-labels";
import { resolveProgressStatus } from "@/lib/issue-progress";
import type { Issue } from "@/types/issue";

/** 左メニュー「ユーザーの作業待ち」の内訳（#1613） */
export type ManualStepAttention = {
  /** openな手作業Issueの件数（左メニューに出す数） */
  total: number;
  /** そのうち、いま実行できるもの */
  actionable: number;
  /** そのうち、起点の変更が本番へ出るまで実行できないもの */
  waitingForRelease: number;
};

/**
 * 手作業Issue（`71.manual-step`）を「いま実行できるもの」と「デプロイ待ちのもの」に分ける（#1613）。
 *
 * 手作業Issueの多くは、起点となった変更が**本番へ出た後**でなければ実行できない（本番サーバーの
 * `.env`を書き換える、デプロイ済みの画面で設定する、など）。左メニューを1件でもあれば強調する
 * ままにすると、数週間先まで実行できない手作業が残っている間ずっと橙色が点いたままになり、
 * 「いま手を動かせば盤面が進む」という合図として読めなくなる。
 *
 * 判定は起点Issueの進捗で行う。手作業Issueの本文`## 関連`に書いた起点Issueの番号を読み
 * （`extractManualStepOrigin`）、同じリポジトリのIssueから引く。起点がまだopenで進捗が`Done`
 * （＝mainへ反映済み）でなければ、その手作業はデプロイ待ちとみなす。
 *
 * **起点を特定できない手作業Issueは「実行できる」側に数える。** 起点の記載が無い・一覧に
 * 載っていない（別リポジトリや取得範囲外）というだけで待ち扱いにすると、実行できる手作業を
 * 見落とすため。強調しすぎて損をする方向へ倒す。
 *
 * @param issues 左メニューの絞り込み（リポジトリなど）を適用したあとのIssue一覧
 * @param referenceIssues 起点Issueを引くための母集団。省略時は`issues`と同じ
 */
export function computeManualStepAttention(
  issues: Issue[],
  referenceIssues: Issue[] = issues,
): ManualStepAttention {
  const byRepositoryAndNumber = new Map<string, Issue>();
  for (const issue of referenceIssues) {
    byRepositoryAndNumber.set(`${issue.repositoryFullName}#${issue.number}`, issue);
  }

  let actionable = 0;
  let waitingForRelease = 0;
  for (const issue of issues) {
    if (issue.state !== "open" || !isManualStepIssue(issue.labels)) continue;
    const originNumber = extractManualStepOrigin(issue.body ?? null);
    const origin =
      originNumber === null
        ? undefined
        : byRepositoryAndNumber.get(`${issue.repositoryFullName}#${originNumber}`);
    if (origin && origin.state === "open" && resolveProgressStatus(origin) !== "done") {
      waitingForRelease += 1;
    } else {
      actionable += 1;
    }
  }

  return { total: actionable + waitingForRelease, actionable, waitingForRelease };
}
