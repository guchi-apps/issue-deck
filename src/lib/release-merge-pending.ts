import type { RepositoryReleaseStatus } from "@/hooks/use-repository-release-statuses";
import { releaseMergeTargetLabel } from "@/lib/github/release-button-status";

/**
 * `develop`・`main`それぞれへの反映待ち（＝人がマージを押す番になっているPR）の件数（#2055）。
 *
 * 数えるのは**PRの本数**であってIssueの件数ではない。フッターに出す数字は
 * 「いま押せば盤面が進むものが何本あるか」で、進捗Status（`Develop`・`Release`）の
 * Issue件数とは母集団が違う（あちらは左メニューの「本番反映待ち」が持つ）。
 */
export type ReleaseMergePendingCounts = {
  /** developへのマージ待ち。バージョンバンプPR（`release/v…` → `develop`）の本数 */
  develop: number;
  /** mainへのマージ待ち。リリースPR（`develop` → `main`）の本数 */
  main: number;
  /** `develop` + `main`。フッターのバッジに出す合計 */
  total: number;
  /** 数えたPRのどれかでチェックが落ちているか（バッジを赤にする条件） */
  hasError: boolean;
};

/**
 * リリース状況のサマリ（`GET /api/repositories/release-pending-merges`）から、
 * developへ・mainへの反映待ちの本数を数える。
 *
 * **未取得（`null`）と0件を区別して返す。** 未取得のうちは`null`を返し、呼ぶ側は数字を
 * 出さない。0を出すと「マージ待ちが無い」と読めてしまうため（PR一覧の件数と同じ作法）。
 *
 * **CIが実行中のPRは数えない。** 数える材料の`pendingMerge`が、CIが`pending`でなくなった
 * 時点でだけ埋まるため（`api/repositories/release-pending-merges/route.ts`。#1433）。
 * 押しても弾かれる状態を「待っている」と数えないのは、通知ベル・リポジトリ一覧のバッジと
 * 同じ判定で、ここだけ基準を変えると同じ状態が場所によって別の数になる。
 *
 * **1リポジトリから数えるのは最大1本。** APIが`pendingMerge`を1つしか返さず、
 * リリースPRとバンプPRが両方openのときはリリースPR（main側）を優先する。
 */
export function countReleaseMergePending(
  releaseStatuses: RepositoryReleaseStatus[] | null,
): ReleaseMergePendingCounts | null {
  if (releaseStatuses === null) return null;

  const pendingMerges = releaseStatuses
    .map((releaseStatus) => releaseStatus.pendingMerge)
    .filter((pendingMerge) => pendingMerge !== null);

  const develop = pendingMerges.filter((merge) => merge.mergeTarget === "develop").length;
  const main = pendingMerges.filter((merge) => merge.mergeTarget === "main").length;

  return {
    develop,
    main,
    total: develop + main,
    hasError: pendingMerges.some((merge) => merge.ciState === "failure"),
  };
}

/**
 * バッジに添える文言（`title`・`aria-label`）。**バッジは合計しか出さない**ため、
 * 内訳はここでしか読めない。文言は`releaseMergeTargetLabel`から得て、通知ベル・
 * ブランチ画面と同じ言い方に揃える。
 */
export function describeReleaseMergePending(counts: ReleaseMergePendingCounts | null): string {
  if (counts === null || counts.total === 0) return "反映待ちはありません";

  return [
    counts.develop > 0 ? `${releaseMergeTargetLabel("develop")}${counts.develop}件` : null,
    counts.main > 0 ? `${releaseMergeTargetLabel("main")}${counts.main}件` : null,
  ]
    .filter((part) => part !== null)
    .join("・");
}
