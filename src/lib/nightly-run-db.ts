/**
 * 予約実行（次枠実行 #2995）で使う`Issue.id`とは別の軽量な鍵。
 *
 * かつては夜間実行のDB読み出し（`readNightlyRunSettings`）・確認待ちPushの保留判定
 * （`selectNightlyRunPushHold`）もここに置いていたが、#3019で夜間実行を削除した。
 */

export function nightlyRunIssueKey(repositoryFullName: string, issueNumber: number): string {
  return `${repositoryFullName}#${issueNumber}`;
}
