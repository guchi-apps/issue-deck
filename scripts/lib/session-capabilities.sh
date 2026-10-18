#!/usr/bin/env bash
# 作業セッションが動くホストの実行能力を実測して表にする（#4522）。
#
# 出力は1行1能力のタブ区切り: `<能力>\t<状態>\t<詳細>`。状態は次の3つだけ。
#   ok         実際に試して使えると確かめられた
#   missing    実際に試して使えないと確かめられた（詳細に理由）
#   unverified 存在は見えるが、使えるかまでは確かめていない（認証の有効性など）
# 「確かめていない」を ok と書かない。セッションは missing / unverified を能力確認済みとして
# 扱わず、別ホスト・API等を評価するか、必要な本人操作だけを依頼する。
#
# 秘密値・認証情報は読まない（存在の有無と起動可否だけを見る）。

CAPABILITY_TIMEOUT_SECONDS="${CAPABILITY_TIMEOUT_SECONDS:-15}"

_cap_row() { printf '%s\t%s\t%s\n' "$1" "$2" "$3"; }

probe_gh_capability() {
  if ! command -v gh >/dev/null 2>&1; then
    _cap_row gh missing "ghコマンドがありません"
  elif timeout "$CAPABILITY_TIMEOUT_SECONDS" gh auth status >/dev/null 2>&1; then
    _cap_row gh ok "gh auth statusが成功"
  else
    _cap_row gh missing "ghが未認証、または応答しません"
  fi
}

probe_vps_ssh_capability() {
  local target="${MANUAL_STEP_VPS_SSH_TARGET:-}"
  if [[ -z "$target" ]]; then
    _cap_row vps-ssh missing "MANUAL_STEP_VPS_SSH_TARGETが未設定"
  elif timeout "$CAPABILITY_TIMEOUT_SECONDS" ssh -o BatchMode=yes -o ConnectTimeout=8 "$target" true >/dev/null 2>&1; then
    _cap_row vps-ssh ok "VPSへ非対話でSSH接続できた"
  else
    _cap_row vps-ssh missing "VPSへ非対話でSSH接続できません"
  fi
}

# ヘッドレスChromiumを実際に起動して確かめる
browser_binary_path() {
  local candidate
  for candidate in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome \
    "$(command -v chromium 2>/dev/null)" "$(command -v chromium-browser 2>/dev/null)" \
    "$(command -v google-chrome 2>/dev/null)"; do
    [[ -n "$candidate" && -x "$candidate" ]] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

probe_browser_capability() {
  local bin
  if ! bin="$(browser_binary_path)"; then
    _cap_row browser-binary missing "Chromium系のブラウザが見つかりません"
  elif timeout "$CAPABILITY_TIMEOUT_SECONDS" "$bin" --headless --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null 2>&1; then
    _cap_row browser-binary ok "ヘッドレス起動に成功"
  else
    _cap_row browser-binary missing "見つかったがヘッドレス起動に失敗"
  fi

  # セッションからブラウザを操作する手段。導入しないまま「あるはず」と扱わない
  if timeout "$CAPABILITY_TIMEOUT_SECONDS" npx --no-install playwright --version >/dev/null 2>&1; then
    _cap_row browser-driver ok "playwrightが導入済み"
  else
    _cap_row browser-driver missing "操作用ドライバ（playwright等）が未導入。導入には依存追加の承認が要る"
  fi

  local profile="${ISSUE_DECK_BROWSER_PROFILE_DIR:-$HOME/.config/issue-deck/browser-profile}"
  if [[ -d "$profile" ]]; then
    _cap_row browser-login unverified "プロファイルはあるがログインが有効かは未確認"
  else
    _cap_row browser-login missing "認証済みプロファイルがありません（ログインが要る操作は本人に依頼する）"
  fi
}

probe_session_capabilities() {
  probe_gh_capability
  probe_vps_ssh_capability
  probe_browser_capability
}

# 表をプロンプトへ埋め込む文面にする
format_session_capabilities() {
  printf '確認時刻: %s（ホスト: %s）\n\n' "$(date '+%Y-%m-%d %H:%M %Z')" "$(hostname)"
  printf '| 能力 | 状態 | 詳細 |\n|---|---|---|\n'
  probe_session_capabilities | awk -F'\t' '{printf "| %s | %s | %s |\n", $1, $2, $3}'
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  probe_session_capabilities
fi
