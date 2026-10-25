/**
 * 同じキーの処理を1本ずつ順に実行する（プロセス内の直列化）。
 *
 * GitHub Releaseの更新には条件付き更新（If-Match）が無く、「取得→書き換え→全体上書き」を
 * 並行して走らせると後の書き込みが先の変更を消す（#5002）。呼び出し側はキーを
 * `リポジトリ＋タグ`にして、同じ本文への読み書きを直列にする。
 */
const tails = new Map<string, Promise<unknown>>();

export function runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
