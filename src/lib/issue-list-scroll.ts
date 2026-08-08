/**
 * Issue一覧のスクロール位置を、scrollTopの数値ではなく「画面上部に見えていたIssueの並びと、
 * その表示オフセット」として保存・復元するための純ロジック（#773）。
 *
 * scrollTopをそのまま復元すると、上に他のIssueが挿入された場合に見えるIssueがずれる。
 * また「実装を開始」等でラベルが変わると、開いていたIssue自身がビューの絞り込みから外れて
 * 一覧から消えるため、単一のIssueを基準にすると復元できなくなる。そこで上から数件分を
 * アンカーとして記録し、残っている最初のIssueを基準に復元する。
 */

/** issueIdの行の上端が、リストのビューポート上端からoffsetFromTopの位置にあったことを表す */
export type IssueListScrollAnchor = {
  issueId: string;
  offsetFromTop: number;
};

export type IssueListScrollPosition = {
  anchors: IssueListScrollAnchor[];
  /** アンカーが1件も残っていない場合の最終手段 */
  scrollTop: number;
};

/** リストの行位置（offsetTopは<ul>を基準にしたリスト内オフセット） */
export type IssueListItemOffset = {
  issueId: string;
  offsetTop: number;
};

/**
 * 保存するアンカーの件数。1件目が消えても後続で復元できるようにする一方、増やしすぎても
 * 上から順に消えるケース以外では効かないため、控えめな件数に留める。
 */
export const ISSUE_LIST_SCROLL_ANCHOR_COUNT = 5;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * 現在のscrollTopと各行のリスト内オフセットから、保存すべきアンカー列を求める。
 *
 * ビューポート上端に最も近い行（上端が隠れて部分的にしか見えていない行を含む）から
 * 下方向にanchorCount件を拾う。offsetFromTopは負値になりうるが、復元時に
 * `offsetTop - offsetFromTop` を計算するため、そのままで見た目が一致する。
 *
 * itemsは表示順（offsetTopの昇順）で渡すこと。
 */
export function collectIssueListScrollAnchors(
  items: IssueListItemOffset[],
  scrollTop: number,
  anchorCount: number = ISSUE_LIST_SCROLL_ANCHOR_COUNT,
): IssueListScrollAnchor[] {
  if (items.length === 0) return [];

  // ビューポート上端以下にある最後の行＝上端が隠れて部分的に見えている行。
  // 該当が無い（scrollTopが先頭行より上）場合は先頭から拾う。
  let startIndex = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].offsetTop <= scrollTop) startIndex = i;
    else break;
  }

  return items.slice(startIndex, startIndex + anchorCount).map((item) => ({
    issueId: item.issueId,
    offsetFromTop: item.offsetTop - scrollTop,
  }));
}

/**
 * 保存済み位置と、復元時点で一覧に残っている行のオフセットから、復元先のscrollTopを求める。
 *
 * アンカーを先頭から順に見て、まだ一覧に残っている最初のIssueを基準にする。すべて消えて
 * いる場合（クローズ・ラベル変更でまとめてフィルターから外れた等）は、保存済みscrollTopを
 * スクロール可能範囲にクランプして返す。
 */
export function computeRestoredIssueListScrollTop(
  position: IssueListScrollPosition,
  offsetTopByIssueId: (issueId: string) => number | undefined,
  maxScrollTop: number,
): number {
  for (const anchor of position.anchors) {
    const offsetTop = offsetTopByIssueId(anchor.issueId);
    if (offsetTop === undefined) continue;
    return clamp(offsetTop - anchor.offsetFromTop, 0, maxScrollTop);
  }
  return clamp(position.scrollTop, 0, maxScrollTop);
}

/**
 * 対象の行がリストの中央に来るscrollTopを求める。保存済み位置が無い場合（URLの
 * `?issue=`・`?missue=`で直接開いた等）のフォールバックに使う。
 */
export function computeCenteredIssueListScrollTop(
  targetOffsetTop: number,
  targetHeight: number,
  viewportHeight: number,
  maxScrollTop: number,
): number {
  return clamp(targetOffsetTop - viewportHeight / 2 + targetHeight / 2, 0, maxScrollTop);
}

/**
 * 一覧の文脈（画面種別・ビュー・絞り込み条件）ごとにスクロール位置を分けるためのキーを作る。
 * 絞り込みを変えたら別の一覧として扱い、先頭から表示する。
 */
export function buildIssueListScrollKey(parts: (string | null | undefined)[]): string {
  return parts.map((part) => part ?? "").join("|");
}
