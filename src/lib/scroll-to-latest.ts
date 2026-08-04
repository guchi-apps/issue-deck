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
