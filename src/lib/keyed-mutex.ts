/**
 * 同じキーの処理を、プロセス内で直列に流す（#2365）。
 *
 * DBの「読んでから書く」を同時に2本走らせると、両方が同じ「読んだ値」を見て書きに行く。
 * issue-deckのIssue同期はまさにその形で、Webhook（`labeled`・`unlabeled`・`edited`）・
 * 定期同期・画面のPATCHが同じ関数を通るため、同じIssueで重なるとユニーク制約違反（P2002）や
 * デッドロック（P2034）でイベントの処理が丸ごと落ちる。
 *
 * **本番のissue-deckはPM2の`instances: 1` / `exec_mode: "fork"`（`deploy/ecosystem.config.js`）で、
 * 上の3経路はすべて同じNodeプロセスに載っている。** そのためプロセス内の直列化で足りる。
 * 複数プロセスへ広げるときは、ここではなくDB側のロックが要る。
 */

/** キーごとの「最後に積んだ処理」。待っている人がいなくなったら捨てる。 */
const chains = new Map<string, Promise<void>>();

/**
 * `key`が同じ`task`同士を、呼ばれた順に1本ずつ実行する。
 *
 * `task`が投げても後続は流れる（1件の失敗で同じIssueの以降の同期を止めない）。戻り値は
 * `task`の結果をそのまま返すので、呼び出し側は`await`するだけでよい。
 */
export function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(task);
  // 鎖には成否を伝えない。伝えると、1件失敗しただけで後続がすべて未処理のまま落ちる
  const guard: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, guard);
  void guard.then(() => {
    // 自分がまだ最後尾ならキーごと捨てる（Issueの数だけMapに溜めない）
    if (chains.get(key) === guard) chains.delete(key);
  });
  return result;
}
