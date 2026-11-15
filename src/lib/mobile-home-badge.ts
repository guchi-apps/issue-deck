import type { MergePendingAttention } from "@/lib/merge-pending-attention";

/**
 * スマホのフッター「ホーム」タブに重ねる件数（#3080・#5434）。
 *
 * **ホーム画面の「要確認」に出ている、人が動く番のものの合計**にする。中身は次の2つで、互いに重ならない。
 *
 * - 「ユーザーの確認待ち」タイルの数（`mobileCheckUserCount`）。マージ待ちPRの対応Issueは
 *   #3650で外してあり、PRは足していない
 * - 「マージ待ち」タイルのうち、人が手を動かすまで進まないもの（`actionRequired`。タイルの
 *   オレンジの丸を点ける条件）。放っておけば入る自動マージ・自動修復中のものは数えない
 *
 * **以前は左メニュー（PC）の確認待ちと同じ数＝確認待ちIssue＋ユーザーがマージするPRを出していた。**
 * #3650でスマホのホームだけが確認待ちからマージ待ちを外した後も、フッターは左メニューの数え方の
 * ままだったため、ホームを開くと要確認が全部0なのにバッジだけ1件残った（#5434）。主にリリースPR
 * （develop→main）で起きていた。リリースPRはホームでは「本番リリース」タイル、フッターでは
 * 「ブランチ」タブの「手が要るもの」（#5423）が受け持つので、「ホーム」では数えない。
 *
 * 「ユーザーの作業待ち」（手作業Issue）は#3080のときから数えていないので、ここでも足さない。
 *
 * @returns 未取得のPRは0として扱う。確認待ちの件数自体が無ければ`null`（バッジを出さない）
 */
export function computeMobileHomeBadgeCount(
  mobileCheckUserCount: number | null,
  mergePendingAttention: MergePendingAttention | null,
): number | null {
  if (mobileCheckUserCount === null) return null;
  return mobileCheckUserCount + (mergePendingAttention?.actionRequired ?? 0);
}
