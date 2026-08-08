#!/usr/bin/env bash
# Fly.io Machine（プレビュー環境）のDockerコンテナ用entrypoint。
# MariaDBを初期化・起動し、イメージに焼き込んだダンプ（存在すれば）をロードしてから
# Next.js standaloneサーバーを起動する。MariaDBをNext.jsより先にreadyにする必要があるため、
# 起動完了をポーリングで待ってからNext.jsを起動する。
#
# ダンプの生成・サニタイズ・installation ID書き換え自体は、デプロイworkflow側の責務（#831）。
# ここではdb-dump/dump.sql.gzが存在する前提でロードする仕組みのみを用意する
# （存在しない場合は空のデータベースのまま起動する）。
set -euo pipefail

DB_DATA_DIR="${DB_DATA_DIR:-/var/lib/mysql}"
DB_SOCKET_DIR="/run/mysqld"
DB_NAME="${DB_NAME:-app_issue_deck}"
DB_USER="${DB_USER:-app}"
DB_PASSWORD="${DB_PASSWORD:-app}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DUMP_PATH="/app/db-dump/dump.sql.gz"

echo "[entrypoint] Initializing MariaDB data directory..."
rm -rf "${DB_DATA_DIR:?}"/*
mkdir -p "$DB_DATA_DIR" "$DB_SOCKET_DIR"
chown -R mysql:mysql "$DB_DATA_DIR" "$DB_SOCKET_DIR"
mariadb-install-db \
  --user=mysql \
  --datadir="$DB_DATA_DIR" \
  --auth-root-authentication-method=normal \
  >/tmp/mariadb-install-db.log 2>&1

echo "[entrypoint] Starting MariaDB..."
mariadbd --user=mysql --datadir="$DB_DATA_DIR" --bind-address=127.0.0.1 &
MARIADB_PID=$!

echo "[entrypoint] Waiting for MariaDB to be ready..."
READY=false
for _ in $(seq 1 30); do
  if mysqladmin ping --silent 2>/dev/null; then
    READY=true
    break
  fi
  sleep 1
done
if [[ "$READY" != "true" ]]; then
  echo "[entrypoint] MariaDB did not become ready in time" >&2
  cat /tmp/mariadb-install-db.log >&2 || true
  exit 1
fi

echo "[entrypoint] Creating application database and user..."
mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'${DB_HOST}' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'${DB_HOST}';
FLUSH PRIVILEGES;
SQL

if [[ -f "$DUMP_PATH" ]]; then
  echo "[entrypoint] Loading DB dump from ${DUMP_PATH}..."
  gunzip -c "$DUMP_PATH" | mysql -uroot "$DB_NAME"
else
  echo "[entrypoint] Warning: dump not found at ${DUMP_PATH}; starting with an empty database" >&2
fi

export DATABASE_URL="mysql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

echo "[entrypoint] Starting Next.js..."
node server.js &
NEXT_PID=$!

shutdown() {
  echo "[entrypoint] Shutting down..."
  kill -TERM "$NEXT_PID" 2>/dev/null || true
  kill -TERM "$MARIADB_PID" 2>/dev/null || true
  wait "$NEXT_PID" 2>/dev/null || true
  wait "$MARIADB_PID" 2>/dev/null || true
}
trap shutdown TERM INT

wait -n "$NEXT_PID" "$MARIADB_PID"
EXIT_CODE=$?
shutdown
exit "$EXIT_CODE"
