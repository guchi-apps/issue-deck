#!/usr/bin/env bash
# ローカル MySQL が未起動なら起動を試みる（開発用）
set -euo pipefail

MYSQL_SOCKET_PATHS=(
  "/var/run/mysqld/mysqld.sock"
  "/run/mysqld/mysqld.sock"
)

is_mysql_listening() {
  # macOSには`ss`が無く`netstat -tln`も形式が違う（`.3306`区切り）ため
  if [[ "$(uname -s)" == "Darwin" ]] && command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:3306 -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | grep -q ':3306 '
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | grep -q ':3306 '
    return $?
  fi
  return 1
}

has_mysql_socket() {
  local socket
  for socket in "${MYSQL_SOCKET_PATHS[@]}"; do
    [[ -S "$socket" ]] && return 0
  done
  return 1
}

is_mysql_available() {
  is_mysql_listening || has_mysql_socket
}

wait_for_mysql() {
  local attempt
  for attempt in $(seq 1 20); do
    if is_mysql_available; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_mysql_macos() {
  local formula
  if ! command -v brew >/dev/null 2>&1; then
    echo "Error: Homebrew が見つかりません。" >&2
    return 1
  fi
  formula="$(brew list --formula 2>/dev/null | grep -E '^mysql(@[0-9.]+)?$' | head -n 1 || true)"
  if [[ -z "$formula" ]]; then
    echo "Error: MySQL がインストールされていません。" >&2
    echo "  → brew install mysql@8.0" >&2
    return 1
  fi
  echo "ローカル MySQL が未起動のため、brew services で起動します（${formula}）..."
  if ! brew services start "$formula"; then
    echo "Error: MySQL の起動に失敗しました。" >&2
    echo "  → brew services start ${formula} を手動で実行してください。" >&2
    return 1
  fi
  if wait_for_mysql; then
    echo "ローカル MySQL: 起動しました"
    return 0
  fi
  echo "Error: MySQL を起動しましたが、ポート 3306 で応答しません。" >&2
  echo "  → brew services list で状態を確認してください。" >&2
  return 1
}

start_mysql() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    start_mysql_macos
    return $?
  fi

  if [[ ! -f /etc/init.d/mysql ]]; then
    echo "Error: MySQL がインストールされていません（/etc/init.d/mysql なし）。" >&2
    echo "  → sudo apt install mysql-server" >&2
    return 1
  fi

  echo "ローカル MySQL が未起動のため、起動を試みます..."

  if sudo -n service mysql start 2>/dev/null; then
    :
  elif sudo service mysql start; then
    :
  else
    echo "Error: MySQL の起動に失敗しました。" >&2
    echo "  → sudo service mysql start を手動で実行してください。" >&2
    return 1
  fi

  if wait_for_mysql; then
    echo "ローカル MySQL: 起動しました"
    return 0
  fi

  echo "Error: MySQL を起動しましたが、ポート 3306 で応答しません。" >&2
  echo "  → sudo service mysql status で状態を確認してください。" >&2
  return 1
}

if [[ "${SKIP_MYSQL_ENSURE:-}" == "1" ]]; then
  exit 0
fi

if is_mysql_available; then
  exit 0
fi

start_mysql
