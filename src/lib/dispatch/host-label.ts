/**
 * 画面・通知に出すディスパッチ先ホストの表記（#1416）。
 *
 * ホスト名（`DispatchHost.name`）は`hostname`そのままの識別子で、poller・tmux・
 * `local-repos.conf`・DBの照合キーを兼ねている。**識別子は変えられないが、人が読む場所に
 * `subpc`という綴りが出るのは表記として揃っていない**（ドキュメントも地の文では「サブPC」と
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
  subpc: "サブPC",
};

/** ホスト名を画面に出す表記へ直す。対応表に無ければそのまま返す */
export function formatDispatchHostName(hostName: string): string {
  return HOST_DISPLAY_NAMES[hostName.toLowerCase()] ?? hostName;
}
