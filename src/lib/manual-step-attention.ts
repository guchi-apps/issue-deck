import { isManualStepIssue } from "@/lib/github/approval-labels";
import {
  extractManualStepReferences,
  resolveManualStepPrerequisites,
  summarizeManualStepPrerequisites,
  type ManualStepPrerequisite,
} from "@/lib/manual-step-prerequisites";
import type { Issue } from "@/types/issue";

/** 左メニュー「ユーザーの作業待ち」の内訳（#1613） */
export type ManualStepAttention = {
  /** openな手作業Issueの件数 */
  total: number;
  /** そのうち、いま実行できるもの（左メニューに出す数。#1763） */
  actionable: number;
  /** そのうち、先に完了している必要があるIssue・PRが残っていて実行できないもの */
  waitingForPrerequisites: number;
};

/** 手作業Issue1件が、いま実行できるか（#1763） */
export type ManualStepReadiness = {
  /** 待っている相手が残っていなければtrue */
  ready: boolean;
  /** まだ待っている参照。`ready`のときは空 */
  blocking: ManualStepPrerequisite[];
  /** Issue詳細の「前提条件の状況」と同じ1行。一覧ではアイコンの説明に使う */
  message: string;
};

/** Issueのid → いま実行できるか。手作業Issue（openな`71.manual-step`）だけが載る */
export type ManualStepReadinessMap = ReadonlyMap<string, ManualStepReadiness>;

/**
 * 手作業Issue（`71.manual-step`）を「いま実行できるもの」と「前提待ちのもの」に分ける（#1613）。
 *
 * 手作業Issueの多くは、先に完了しているべき変更が**本番へ出た後**でなければ実行できない
 * （本番サーバーの`.env`を書き換える、デプロイ済みの画面で設定する、など）。左メニューを
 * 1件でもあれば強調するままにすると、数週間先まで実行できない手作業が残っている間ずっと
 * 橙色が点いたままになり、「いま手を動かせば盤面が進む」という合図として読めなくなる。
 *
 * **件数（左メニュー・スマホのホーム）も`actionable`だけを出す**（#1763。数え直しは
 * `issue-stats.ts`の`computeNavCounts`）。総数のままだと、強調が消えても数字だけが減らず、
 * 「いま何件やれるのか」を数から読めない。
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
  for (const readiness of computeManualStepReadiness(issues, referenceIssues).values()) {
    if (readiness.ready) actionable += 1;
    else waitingForPrerequisites += 1;
  }

  return { total: actionable + waitingForPrerequisites, actionable, waitingForPrerequisites };
}

/**
 * 手作業Issueを1件ずつ判定する（#1763）。件数（`computeManualStepAttention`）も一覧の行の
 * アイコン（`issue-list.tsx`）もここを見るので、**同じIssueに対して数と印が食い違わない**。
 *
 * 判定の中身と「状態不明を待ちに数えない」理由は上のコメントのとおり。
 *
 * @param issues 判定の対象。左メニューの絞り込みを適用したあとの一覧でよい
 * @param referenceIssues 参照先を引くための母集団。省略時は`issues`と同じ
 */
export function computeManualStepReadiness(
  issues: Issue[],
  referenceIssues: Issue[] = issues,
): ManualStepReadinessMap {
  const readinessByIssueId = new Map<string, ManualStepReadiness>();
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
    const summary = summarizeManualStepPrerequisites(prerequisites, issue.repositoryFullName);
    readinessByIssueId.set(issue.id, {
      ready: summary.blocking.length === 0,
      blocking: summary.blocking,
      message: summary.message,
    });
  }
  return readinessByIssueId;
}

/**
 * Issue一覧のヘッダーに出す件数（#1763）。
 *
 * 左メニューが「いま実行できる件数」を出すようになったため、一覧のヘッダーが行数（前提待ちを
 * 含む総数）のままだと、メニューの数と一覧の数だけが食い違う（#1713と同じ問題）。
 * **メニューと同じ数を先に出し、その差である前提待ちを添える。**
 * スマホはアイコンにカーソルを合わせられないので、内訳を読めるのはここだけになる。
 *
 * @returns 手作業Issueが1件も無ければnull（呼び出し側は今までどおりの「N件」を出す）
 */
export function formatManualStepListCount(
  issues: Issue[],
  readiness: ManualStepReadinessMap,
): string | null {
  let actionable = 0;
  let waiting = 0;
  for (const issue of issues) {
    const state = readiness.get(issue.id);
    if (!state) continue;
    if (state.ready) actionable += 1;
    else waiting += 1;
  }
  if (actionable === 0 && waiting === 0) return null;
  if (waiting === 0) return `${actionable}件`;
  return `${actionable}件・前提待ち${waiting}件`;
}
