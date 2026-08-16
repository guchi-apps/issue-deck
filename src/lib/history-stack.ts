/**
 * このタブでissue-deck自身が積んだ履歴エントリの数を数える（#1396）。
 *
 * アプリ内の「戻る」ボタン・右スワイプは、自分が積んだ履歴があるなら`router.back()`で
 * 巻き戻したい。押すたびに新しいエントリを積むと、戻る操作が往復を積み上げるだけになり
 * ブラウザ・OSの戻るが前の画面へ着かなくなるため。ただし共有URLで深い画面をいきなり開いた
 * 場合は巻き戻せる履歴が無く、そこで`router.back()`を呼ぶとアプリの外へ出てしまう。
 * その判別のために、自分のpushだけを数える。
 *
 * 数えるのはpushとpopstateだけで、ズレは必ず「0に近づく側」＝戻り先を計算して遷移する
 * フォールバック側に倒れる（アプリの外へ出す側には倒れない）。進む操作でもpopstateは発火する
 * ため実際の深さより小さくなることはあるが、その場合に起きるのは履歴が1つ増えることだけ。
 * ページを再読み込みすると0に戻る（＝フォールバック）。
 */
let depth = 0;

/**
 * 「巻き戻せるか」が変わったことを知りたい購読者（#1771）。
 *
 * PC版ヘッダーの戻るボタンは、巻き戻せないときは押せない状態にする。この値はモジュール変数
 * なので、変わったことをReactへ伝える経路が要る（`useCanGoBackInApp`が`useSyncExternalStore`
 * から購読する）。**通知するのは`canGoBackInApp()`の真偽が変わったときだけ**で、深さが1→2の
 * ように増えただけでは通知しない（見た目が変わらない再描画になるため）。
 */
const listeners = new Set<() => void>();

function setDepth(next: number): void {
  const before = canGoBackInApp();
  depth = next;
  if (canGoBackInApp() === before) return;
  for (const listener of listeners) listener();
}

/** 履歴エントリを1つ積んだ */
export function recordHistoryPush(): void {
  setDepth(depth + 1);
}

/** ブラウザ・OSの履歴移動が起きた */
export function recordHistoryPop(): void {
  setDepth(Math.max(0, depth - 1));
}

/** 自分が積んだ履歴を巻き戻せるか */
export function canGoBackInApp(): boolean {
  return depth > 0;
}

/** 巻き戻せるかどうかが変わったら`listener`を呼ぶ。戻り値は購読の解除 */
export function subscribeHistoryStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** テスト用。実行時には呼ばない */
export function resetHistoryStack(): void {
  setDepth(0);
}
