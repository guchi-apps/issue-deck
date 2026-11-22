/**
 * 画面・通知に出すディスパッチ先ホストの表記（#1416）。
 *
 * ホスト名（`DispatchHost.name`）は`hostname`そのままの識別子で、poller・tmux・
 * `local-repos.conf`・DBの照合キーを兼ねている。**識別子は変えられないが、人が読む場所に
 * `subpc`という綴りが出るのは表記として揃っていない**（ドキュメントも地の文では「DeskMini」と
 * 書いている）ため、表示するときだけここで日本語表記へ置き換える。
 *
 * 対応表に無いホストはそのまま返す。**未知のホストを勝手に加工しない**のは、表示から
 * `local-repos.conf`やDBの値を推測できる状態を保つため。
 *
 * 適用するのは**地の文だけ**にする。バッククォートで囲んだコード引用（`tmux attach`の相手や
 * `- ホスト: \`subpc\``のような技術的な明細）・ファイル名・設定値・コマンドは、コピーして
 * そのまま使う値なので識別子のまま残す。
 */
const HOST_DISPLAY_NAMES: Record<string, string> = {
  subpc: "DeskMini",
  // DeskMiniと並ぶ2台目の常時起動ホスト（#5528）。識別子はstatus-hubのホスト統計と同じ`macmini`
  macmini: "Mac mini",
};

/**
 * メインのホスト。画面の並び順の先頭になり、「実装を開始」の既定の実行先もこのホストに寄る（#5569）。
 * 以前は名前の昇順（`macmini`＜`subpc`）で返していたため、Mac miniが先頭・既定になっていた。
 */
export const PRIMARY_DISPATCH_HOST = "subpc";

/** ホストを表示順（メインのサブPCが先頭、残りは名前順）に並べた新しい配列を返す */
export function sortDispatchHosts<T extends { name: string }>(hosts: readonly T[]): T[] {
  const rank = (name: string) => (name.toLowerCase() === PRIMARY_DISPATCH_HOST ? 0 : 1);
  return [...hosts].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** ホスト名を画面に出す表記へ直す。対応表に無ければそのまま返す */
export function formatDispatchHostName(hostName: string): string {
  return HOST_DISPLAY_NAMES[hostName.toLowerCase()] ?? hostName;
}
