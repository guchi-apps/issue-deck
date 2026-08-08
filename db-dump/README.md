# db-dump/

Fly.io Machines上のプレビュー環境（#826）が起動時にMariaDBへロードする本番DBダンプの配置先。

- ダンプ本体（`dump.sql.gz`）はこのリポジトリにコミットしない（`.gitignore`・`.dockerignore`で除外済み）。
- ダンプの生成・サニタイズ（ユーザートークンのNULL化）・installation ID書き換えは、デプロイworkflow
  （`.github/workflows/deploy-preview.yml`、#831で追加予定）の責務。そのworkflowが`fly deploy`直前に
  `db-dump/dump.sql.gz`を配置してからDockerイメージをビルドする。
- `Dockerfile`は`db-dump/`ディレクトリごとイメージへコピーし、`scripts/preview-entrypoint.sh`が
  コンテナ起動のたびに`db-dump/dump.sql.gz`が存在すればMariaDBへロードする（存在しない場合は
  空のデータベースのまま起動する）。
