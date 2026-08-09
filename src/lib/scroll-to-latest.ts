/**
 * スクロールコンテナ内の対象要素の上端を、コンテナの上端に一致させるために必要な
 * scrollTopを計算する。containerTop・targetTopはgetBoundingClientRect().topなど
 * ビューポート基準の座標を渡す。
 */
export function computeScrollTopToRevealTarget(
  containerScrollTop: number,
  containerTop: number,
  targetTop: number,
): number {
  return containerScrollTop + (targetTop - containerTop);
}

/**
 * 「まだ見ていない最初のコメント」のインデックス（0始まり）を求める。
 * readCommentCountは「ユーザーが最後に読んだ時点でのコメント総数」なので、そのまま
 * 未読コメント配列のインデックスとして扱える。全件既読・削除等でreadCommentCountが
 * コメント総数以上になっている場合は最後のコメントのインデックスを返す。
 */
export function computeFirstUnreadCommentIndex(
  readCommentCount: number,
  commentCount: number,
): number {
  if (commentCount <= 0) return 0;
  if (readCommentCount >= commentCount) return commentCount - 1;
  return Math.max(0, readCommentCount);
}

/** 「対象コメント上端に到達済み」とみなすscrollTopの許容誤差（px） */
const REACHED_TARGET_TOLERANCE_PX = 4;

/**
 * 現在のscrollTopが、対象コメント上端に到達するのに必要なscrollTop
 * （containerScrollTop + (targetTop - containerTop)）とほぼ一致しているか
 * （＝1回前のクリックで既にそこへ移動済みか）を判定する。
 */
export function isAtScrollTarget(params: {
  containerScrollTop: number;
  containerTop: number;
  targetTop: number;
}): boolean {
  const targetScrollTop = computeScrollTopToRevealTarget(
    params.containerScrollTop,
    params.containerTop,
    params.targetTop,
  );
  return Math.abs(params.containerScrollTop - targetScrollTop) <= REACHED_TARGET_TOLERANCE_PX;
}

/**
 * 「ページ下部へ移動」ボタンの移動先scrollTopを求める。クリック時点のscrollTopが、
 * 対象コメント上端に到達するのに必要なscrollTopとほぼ一致している（＝1回前のクリックで
 * 既にそこへ移動済み）場合は、スクロールコンテナの最下部（承認ボタン・コメント入力欄を
 * 含む末尾）へ移動する。まだ到達していない場合は、対象コメント上端へ移動する。
 */
export function computeScrollToLatestTarget(params: {
  containerScrollTop: number;
  containerTop: number;
  targetTop: number;
  containerScrollHeight: number;
}): number {
  const targetScrollTop = computeScrollTopToRevealTarget(
    params.containerScrollTop,
    params.containerTop,
    params.targetTop,
  );
  return isAtScrollTarget(params) ? params.containerScrollHeight : targetScrollTop;
}
