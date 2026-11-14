# リリース履歴の項目チェックとGitHub Release本文の連動（#4374）

リリース履歴の箇条書き1行ごとのチェック（#2982）は、**GitHub Release本文のMarkdownタスクリスト（`- [ ]` / `- [x]`）を正**とする共有状態。ユーザーごとのDB記録（`ReleaseCheckLine`）は旧記録で、もう書き込まない。

## 読み書きの流れ

- 読み取り: `GET /api/repositories/release-history`が、**DBの写し（`ReleaseHistoryCache`）を正として**Release本文から確認記録を組み立てる（`lib/release-body-tasks.ts`の`buildCheckLineRecordsFromBodies`）。写しが鮮度（15分。`RELEASE_HISTORY_CACHE_TTL_MS`）内のリポジトリはGitHubを呼ばず、無い・古いもの・更新ボタン（`?refresh=1`）だけGitHubから取り直して保存する（#5392）。
- 写しの更新契機: ①画面・TTL超過時の取り直し ②Webhook`release`イベント（GitHub Appが`release`を購読している場合）③項目チェック保存時（`patchReleaseHistoryCacheBody`が該当版の本文だけ差し替え）。取り直しの深さは全ユーザーの確認対象の最も古い時刻（`findMinCheckSinceMsByRepositoryId`）に合わせる。
- **タグだけの版**（Releaseが無い失敗版）は`release`イベントで変化を受けられず、反映は最大15分遅れる（更新ボタンで即時）。
- 画面を開いた直後は前回の取得結果（`release-history/cached`。#5230）を出し、最新（鮮度内の写しを含む）が届くまで項目チェックを押せなくする。写しの本文で押すと、GitHub側で変わった行を古い状態から書き換えかねないため。鮮度内の写しで押した場合も、書く直前に本文を取り直し競合を検出するので古い本文では上書きしない。
- 書き込み: `POST/DELETE /api/repositories/release-check-lines`が、書く直前に本文を取り直し、**該当行の先頭（`* ` → `- [x] `）だけ**を書き換えて`PATCH /releases/{id}`する。書いた後にもう一度読み、意図した状態になっていなければ`conflict`を返す（画面は「保存済み」にせず、本文を取り直す）。
- 行の識別子は、PRの参照（`... in <URL>`）か、取り出せない手書きの行では本文そのもの。並び順・文言変更・他の行の編集に影響されない。同じ参照の行が複数あれば同じ項目として揃える。
- 失敗版から引き継いだ項目は、**本番へ反映された修正版のRelease本文**の`### vX.Y.Zから引き継いだ変更`の節へ、行末に`<!-- issue-deck:key=... -->`を付けて初回のチェック時に書き足す。失敗版（Releaseが無い版）は同期済みとして扱わない。
- 新規リリース生成（`deploy.yml`・`release.yml`・新規アプリの雛形）は、Release作成直後に`* `の箇条書きを`- [ ] `へ変換する。変換済みの行は触らないので再実行しても状態は変わらない。

## 制約・既知の限界

- GitHubのReleases APIには条件付き更新（If-Match）が無い。取得から更新までの短い間の同時編集は防げないため、更新後の読み直しで検出して`conflict`として返す。古い本文を丸ごと書き戻すことはしない（最新を取り直してから該当行だけ変える）。
- 更新には**GitHub Appの`Contents: Read & write`権限**が要る。権限が無いと`permission_denied`となり、画面にその旨が出て保存済みにはならない。
- 項目チェックは参考記録のまま。「全項目チェックしないと確認済みにできない」制約は無く、リリース全体の「確認済み」（`ReleaseCheck`）・確認対象リポジトリ設定・未確認件数は従来どおり。

## 旧記録（`ReleaseCheckLine`）の移行

- 表示: 本文にタスクリストの行があればその状態を使い、**通常の箇条書きのままの行・本文に行が無い項目だけ**旧記録を使う（旧記録でGitHubのチェックを上書きしない）。
- 統合規則: 複数ユーザーの旧記録は和集合（誰か1人でも確認していれば確認済み）。
- 一括移行: `POST /api/repositories/release-check-lines/migrate`（`{ "dryRun": true }`が既定。`false`で本文を書き換える。30リリースずつ、`offset`で続ける）。通常の箇条書きだけを、旧記録があれば`- [x]`、なければ`- [ ]`へ変換する。本文に行が無い旧記録（引き継ぎ項目）は`unmigratable`として件数を返し、DBに残す。
- **旧記録は削除しない。** 移行結果を検証してから別途判断する。移行後の初回確認が済むまで、`ReleaseCheckLine`テーブルとマイグレーションは残す。
