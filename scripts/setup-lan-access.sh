#!/usr/bin/env bash
# WSL2は内部NAT構成のため、LAN上の別端末（スマホ等）からdevサーバーへアクセスするには
# Windows側でポートフォワーディング（netsh portproxy）とファイアウォール許可が必要。
# WSLのIPはWSL再起動のたびに変わるため、devサーバー起動のたびにこのスクリプトを実行して追従させる。
#
# 使い方:
#   scripts/setup-lan-access.sh <port> [port...]
#
# Windows側の管理者権限が必要なため、実行のたびにUAC確認ダイアログが表示される
# （毎回の承認が煩わしい場合は、ユーザー自身でタスクスケジューラ等による恒久設定を検討すること）。
# WSL以外の環境やpowershell.exeが無い環境では何もせず正常終了する。

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/setup-lan-access.sh <port> [port...]" >&2
  exit 1
fi

for port in "$@"; do
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    echo "Error: ポート番号は数字で指定してください: $port" >&2
    exit 1
  fi
done

if ! command -v powershell.exe >/dev/null 2>&1; then
  echo "情報: powershell.exe が見つからないため、LANアクセス設定をスキップします（WSL環境専用の機能です）。" >&2
  exit 0
fi

WSL_IP="$(ip -4 addr show eth0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' || true)"
if [[ -z "$WSL_IP" ]]; then
  echo "警告: WSLのIPアドレスを取得できなかったため、LANアクセス設定をスキップします。" >&2
  exit 0
fi

PORTS_ARG="$*"

# 管理者権限で実行する側（netsh portproxy・ファイアウォール規則の追加/削除）。
INNER_SCRIPT=$(cat <<PS1
\$ErrorActionPreference = 'Continue'
\$ports = "${PORTS_ARG}" -split ' '
foreach (\$port in \$ports) {
  netsh interface portproxy delete v4tov4 listenport=\$port listenaddress=0.0.0.0 | Out-Null
  netsh interface portproxy add v4tov4 listenport=\$port listenaddress=0.0.0.0 connectport=\$port connectaddress=${WSL_IP} | Out-Null
  \$ruleName = "WSL issue-deck Dev \$port"
  Remove-NetFirewallRule -DisplayName \$ruleName -ErrorAction SilentlyContinue | Out-Null
  New-NetFirewallRule -DisplayName \$ruleName -Direction Inbound -Protocol TCP -LocalPort \$port -Action Allow | Out-Null
}
PS1
)
INNER_ENCODED="$(printf '%s' "$INNER_SCRIPT" | iconv -t UTF-16LE | base64 -w0)"

# 非elevatedな外側: elevatedプロセスを起動してUAC許可を待つだけ。UAC拒否時は例外になるので拾って終了コードに反映する。
OUTER_SCRIPT=$(cat <<PS2
\$ErrorActionPreference = 'Stop'
try {
  \$p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${INNER_ENCODED}'
  if (\$p.ExitCode -ne 0) { exit 1 }
} catch {
  Write-Error \$_
  exit 1
}
PS2
)
OUTER_ENCODED="$(printf '%s' "$OUTER_SCRIPT" | iconv -t UTF-16LE | base64 -w0)"

echo "Windowsの管理者権限でポートフォワーディングを設定します（UACダイアログが表示された場合は許可してください）..."
if powershell.exe -NoProfile -NonInteractive -EncodedCommand "$OUTER_ENCODED"; then
  echo "LAN経由でのアクセスURL（同一LAN上の別端末から）:"
  for port in "$@"; do
    echo "  http://${WSL_IP}.sslip.io:${port}"
  done
else
  echo "警告: ポートフォワーディングの設定に失敗しました（UACをキャンセルした可能性があります）。localhostでの確認は引き続き可能です。" >&2
fi
