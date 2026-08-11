"use client";

/**
 * 「ローカル起動のセットアップ」ダイアログの表示・登録の記録をブラウザに残す（#1088）。
 *
 * `issuedeck://`が登録済みかどうかを**ブラウザから知る手段は無い**。未登録の環境でボタンを
 * 押しても、ブラウザが未知のスキームを黙って無視するだけでエラーも遷移も観測できない
 * （遷移後に`blur`が来るかを見る裏技はあるが、ブラウザ自身の確認ダイアログがフォーカスを
 * 奪うため誤検知する）。そのため「状況を検知して出す」のではなく、初回のボタン押下時に
 * こちらから一度だけ見せる。その「一度きり」を成立させる記録がこれ。
 */
const SETUP_SEEN_KEY = "issue-deck:local-session-setup-seen";

/**
 * 登録コマンドを最後にコピーしたときのアプリのバージョン。
 *
 * 受け口スクリプトを更新したら登録スクリプトの再実行が要る（複製が古いままになる）。
 * 登録そのものは検知できないので、コピーした時点の版を控えておき、現在の版と並べて
 * 「いつの版で登録したか」を人が照合できるようにする。
 */
const REGISTERED_VERSION_KEY = "issue-deck:local-session-registered-version";

/** セットアップ手順を一度でも見せたか */
export function hasSeenLocalSessionSetup(): boolean {
  return window.localStorage.getItem(SETUP_SEEN_KEY) !== null;
}

/** セットアップ手順を見せたことを記録する */
export function markLocalSessionSetupSeen(): void {
  window.localStorage.setItem(SETUP_SEEN_KEY, "1");
}

/** 登録コマンドを最後にコピーしたときのバージョン（一度もコピーしていなければnull） */
export function readLocalSessionRegisteredVersion(): string | null {
  return window.localStorage.getItem(REGISTERED_VERSION_KEY);
}

/** 登録コマンドをコピーした時点のバージョンを控える */
export function writeLocalSessionRegisteredVersion(version: string): void {
  window.localStorage.setItem(REGISTERED_VERSION_KEY, version);
}
