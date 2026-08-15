import type { CheckUserScrollTarget } from "@/lib/github/check-user-guidance";

/**
 * 「次の操作」をする場所に付ける目印（#1663）。
 *
 * **idではなくdata属性なのは、PC版とスマホ版が同時にDOMへ乗るため。** レイアウトの出し分けは
 * `md:hidden`／`hidden md:flex`によるCSSで、`IssueDetail`と`MobileIssueDetail`の両方が
 * 描かれている状態が普通にある（`issue-deck-shell.tsx`）。同じidを2つ置くとHTMLとして不正な
 * うえ、`getElementById`が先に来る非表示側を返して**押しても何も起きない**。
 */
export const CHECK_USER_TARGET_ATTR = "data-check-user-target";

/** 目印を付ける要素へ広げるprops（`<div {...checkUserTargetProps("approval")}>`） */
export function checkUserTargetProps(target: CheckUserScrollTarget) {
  return { [CHECK_USER_TARGET_ATTR]: target };
}

/** 着いた先を一瞬光らせるためのクラス（実体は`globals.css`のキーフレーム） */
const FLASH_CLASS = "check-user-flash";

/** ハイライトの表示時間。`globals.css`のアニメーション長と揃える */
const FLASH_DURATION_MS = 1600;

/**
 * 表示されている方の目印を選ぶ。`display:none`の要素は`offsetParent`がnullになる
 * （jsdomでは常にnullなので、その場合は先頭へフォールバックする）。
 */
function findVisibleTarget(doc: Document, target: CheckUserScrollTarget): HTMLElement | null {
  const nodes = [
    ...doc.querySelectorAll<HTMLElement>(`[${CHECK_USER_TARGET_ATTR}="${target}"]`),
  ];
  if (nodes.length === 0) return null;
  return nodes.find((node) => node.offsetParent !== null) ?? nodes[0];
}

/**
 * 「次の操作」をする場所までスクロールし、その枠を一瞬ハイライトする（#1663）。
 *
 * 着く先が長いコメント欄の末尾でも、どの枠のことなのかが分かるようにする。
 * **要素が見つからなければ何もしない**（対応PRが無いIssueなど）。呼び出し側が
 * 押せる状態かを判断できるよう、動かせたかどうかを返す。
 *
 * @returns 対象が見つかってスクロールしたか
 */
export function focusCheckUserTarget(
  target: CheckUserScrollTarget,
  doc: Document | null = typeof document === "undefined" ? null : document,
): boolean {
  const element = doc ? findVisibleTarget(doc, target) : null;
  if (!element || !doc) return false;

  element.scrollIntoView({ behavior: "smooth", block: "center" });

  // 連打しても毎回光るように、いったん外してからアニメーションを掛け直す
  element.classList.remove(FLASH_CLASS);
  // レイアウトを読んでアニメーションの再生をリセットする（jsdomでは0のまま実害は無い）
  void element.offsetWidth;
  element.classList.add(FLASH_CLASS);
  doc.defaultView?.setTimeout(() => element.classList.remove(FLASH_CLASS), FLASH_DURATION_MS);

  return true;
}
