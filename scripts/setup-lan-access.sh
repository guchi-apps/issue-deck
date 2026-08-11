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
#
# 環境変数:
#   ISSUE_DECK_LAN_SETUP_TIMEOUT  UAC待ちの上限秒数（既定60。0で無制限）
#
# wt.exeで開いたタブから実行した場合、UACを承認して中の処理が成功しても
# `Start-Process -Verb RunAs -Wait` が待ちから戻らないことがある（#1076・#1094）。
# 呼び出し元が無反応のまま止まるのを避けるため、待ちには上限を設けている。

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

# UAC待ちから戻らない場合に呼び出し元を巻き込まないよう上限を設ける（#1094）。
# timeoutが無い環境や 0 指定では従来どおり無制限に待つ。
TIMEOUT_SEC="${ISSUE_DECK_LAN_SETUP_TIMEOUT:-60}"
RUNNER=()
if [[ "$TIMEOUT_SEC" != "0" ]] && command -v timeout >/dev/null 2>&1; then
  RUNNER=(timeout --kill-after=5 "$TIMEOUT_SEC")
fi

echo "Windowsの管理者権限でポートフォワーディングを設定します（UACダイアログが表示された場合は許可してください）..."
STATUS=0
${RUNNER[0]+"${RUNNER[@]}"} powershell.exe -NoProfile -NonInteractive -EncodedCommand "$OUTER_ENCODED" || STATUS=$?

if [[ "$STATUS" -eq 0 ]]; then
  echo "LAN経由でのアクセスURL（同一LAN上の別端末から）:"
  for port in "$@"; do
    echo "  http://${WSL_IP}.sslip.io:${port}"
  done
elif [[ "$STATUS" -eq 124 || "$STATUS" -eq 137 ]]; then
  # UACダイアログを承認済みでも、Windows側の管理者プロセスは残ることがある（起動済みの
  # portproxy設定はそのまま有効になる）。ここでは呼び出し元を先へ進めることを優先する。
  echo "警告: ポートフォワーディングの設定が ${TIMEOUT_SEC} 秒以内に完了しなかったため打ち切りました。localhostでの確認は引き続き可能です。" >&2
  exit 1
else
  echo "警告: ポートフォワーディングの設定に失敗しました（UACをキャンセルした可能性があります）。localhostでの確認は引き続き可能です。" >&2
  exit 1
fi
