# PR自動修復テーブルのマイグレーション復旧

MySQLのインデックス名は64文字以内にする。SQLとPrismaの明示的mapを揃える。

本マイグレーションはCREATE TABLE一文で構成される。デプロイ時の修復スクリプトは、未解決失敗が1件・成功履歴なし・対象テーブルなしの場合だけprisma migrate resolve --rolled-backを実行する。テーブル削除や適用済み扱いへの変更はしない。既存テーブルや矛盾する履歴では停止して調査する。

修復スクリプトを配布物へ含め、migrate deployより先に実行する。正常時と解決済み時は何もしない。修正の反映は新バージョンのリリースを経由し、既存v8.34.0タグは移動しない。古いコミットの再実行だけでは復旧しない。

検証: node --test scripts/repair-failed-pull-request-auto-repair-loop.test.mjs

本番復旧の完了はdeployのmigration・再起動・ヘルスチェック成功で判定する。
