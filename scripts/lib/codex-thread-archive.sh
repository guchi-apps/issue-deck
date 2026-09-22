#!/usr/bin/env bash
# ChatGPTアプリのリモート制御を「今動いているCodexセッションの一覧」に保つ（#3357）。
#
# 繋いだChatGPTアプリに出るのは、そのホストのapp-serverが持つ**アーカイブされていない
# スレッド全部**（`thread/list`の既定）で、終わったセッションも消えずに並び続ける
# （2026-09-22時点で、動いているのは1本なのに過去のIssueのセッションが上から並んでいた）。
# そこで2つのことをpollerの巡回から行う。
#
#   1. 終わったセッションのスレッドを`thread/archive`でアーカイブする（**削除はしない**。
#      `codex resume`で前回の会話を引き継ぐときは`thread/unarchive`で戻す）
#   2. Remote Controlを有効にしたホストで、app-serverのデーモンが落ちていれば起こし直す
#      （再起動のあと、Codexのセッションを起こすか「Codexに繋ぐ」を押すまでオフラインだった）
#
# 実機（codex-cli 0.152.1）で分かっていること。
#
#   - **ChatGPTアプリで開いたスレッドはデーモンが書き手を握る。** stdioで起こした
#     `codex app-server`から打つと`already has an active writer`で拒否されるため、
#     デーモンの制御ソケットへ送る（`lib/codex-app-server-rpc.py`）
#   - アーカイブ済みのスレッドへもう一度`thread/archive`を打つと`no rollout found`が返る。
#     転記が1行も無いまま終わったスレッドも同じ。**どちらも隠すものが無いので済んだ扱い**
#   - `thread/unarchive`で元の一覧へ戻る
#
# 対象は**issue-deckが起こしたセッションだけ**（`.codex-thread`を持つもの）。ChatGPTアプリから
# 直接始めた会話には触らない。
#
# このファイル自体は実行せず、source して使う。`lib/session-state.sh`を先に読み込んでおくこと。

CODEX_THREAD_ARCHIVE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 終わったセッションのアーカイブを止めるスイッチ（0で無効）。**壊れたときに黙って止められる逃げ道。**
CODEX_THREAD_ARCHIVE_ENABLED="${ISSUE_DECK_CODEX_ARCHIVE_ENDED:-1}"

# デーモンの起こし直しを止めるスイッチ（0で無効）。
CODEX_REMOTE_KEEPALIVE_ENABLED="${ISSUE_DECK_CODEX_REMOTE_KEEPALIVE:-1}"

# 起こし直しを試す間隔（分）。**落ち続ける状態で30秒ごとに`start`を打ち直さない**ため。
CODEX_REMOTE_KEEPALIVE_INTERVAL_MINUTES="${ISSUE_DECK_CODEX_REMOTE_KEEPALIVE_INTERVAL_MINUTES:-5}"

CODEX_REMOTE_KEEPALIVE_STAMP="${ISSUE_DECK_CODEX_REMOTE_KEEPALIVE_STAMP:-${XDG_STATE_HOME:-$HOME/.local/state}/issue-deck/codex-remote-keepalive.stamp}"

# 1本の呼び出しの打ち切り（秒）。**待たされ続けないための保険**（Pythonの側にも同じ上限がある）。
CODEX_THREAD_ARCHIVE_TIMEOUT_SECONDS="${ISSUE_DECK_CODEX_ARCHIVE_TIMEOUT_SECONDS:-30}"

# 送る実体。**差し替えられるのは検証のときだけ。**
CODEX_THREAD_ARCHIVE_RPC="${ISSUE_DECK_CODEX_RPC_COMMAND:-$CODEX_THREAD_ARCHIVE_LIB_DIR/codex-app-server-rpc.py}"

codex_thread_archive_home() {
  printf '%s' "${CODEX_HOME:-$HOME/.codex}"
}

# スレッドへ1本送る。返り値は`codex-app-server-rpc.py`のまま（0/2/3/4）。
codex_thread_archive_rpc() {
  local method="$1" thread="$2" status=0
  [[ "$thread" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || {
    echo "スレッドUUIDの形ではありません"
    return 2
  }
  if [[ "$CODEX_THREAD_ARCHIVE_RPC" == *.py ]]; then
    command -v python3 >/dev/null 2>&1 || {
      echo "python3 が無いため送れませんでした"
      return 2
    }
    timeout "$CODEX_THREAD_ARCHIVE_TIMEOUT_SECONDS" python3 "$CODEX_THREAD_ARCHIVE_RPC" \
      "$method" "{\"threadId\":\"$thread\"}" || status=$?
  else
    timeout "$CODEX_THREAD_ARCHIVE_TIMEOUT_SECONDS" "$CODEX_THREAD_ARCHIVE_RPC" \
      "$method" "{\"threadId\":\"$thread\"}" || status=$?
  fi
  # `timeout`の124は「応答が無かった」として扱う
  ((status == 124)) && status=2
  return "$status"
}

# `codex resume`の前にアーカイブを戻す。**印のあるときだけ送る**（無ければ何もしない）。
#
# 戻せなくても起動は止めない——戻っていなければ`codex resume`が前回の会話を見つけられず
# 失敗するだけで、それはこの経路が無かった頃と同じ壊れ方になる。
codex_thread_unarchive_for_resume() {
  local session="$1" thread="$2" out status=0
  session_state_codex_archived_is "$session" "$thread" || return 0
  out="$(codex_thread_archive_rpc thread/unarchive "$thread")" || status=$?
  if ((status == 0)); then
    session_state_clear_codex_archived "$session" || true
    return 0
  fi
  echo "${out:-アーカイブを戻せませんでした}"
  return 2
}

# 終わったセッションのスレッドをアーカイブする（1巡ぶん）。
#
# 引数は**今動いているtmuxセッション名**（ペインが生きているもの）。それ以外で`.codex-thread`を
# 持つセッションを「終わった」と読む。**判定に`codex`を起こさない**——済んだものは
# `.codex-archived`の印で見送るので、2巡目以降は状態ディレクトリを読むだけで終わる。
#
# 標準出力へ、アーカイブした件数と見送った理由を1行ずつ出す（pollerのログ用）。
codex_thread_archive_ended() {
  [[ "$CODEX_THREAD_ARCHIVE_ENABLED" == "1" ]] || return 0
  local dir file session thread out status live
  declare -A live_sessions=()
  for live in "$@"; do
    [[ -n "$live" ]] && live_sessions["$live"]=1
  done

  dir="$(session_state_dir)"
  [[ -d "$dir" ]] || return 0
  local archived=0
  for file in "$dir"/*.codex-thread; do
    [[ -f "$file" ]] || continue
    session="$(basename "$file" .codex-thread)"
    [[ -n "${live_sessions[$session]:-}" ]] && continue
    thread="$(session_state_read_codex_thread "$session" 2>/dev/null || true)"
    [[ -n "$thread" ]] || continue
    session_state_codex_archived_is "$session" "$thread" && continue

    status=0
    out="$(codex_thread_archive_rpc thread/archive "$thread")" || status=$?
    case "$status" in
      # 3（転記が無い）はアーカイブ済みか、転記の無いまま終わったもの。どちらも隠すものが無い
      0 | 3)
        session_state_mark_codex_archived "$session" "$thread" || true
        ((status == 0)) && archived=$((archived + 1))
        ;;
      # 4（書き手がいる）は、tmuxの外でまだ動いている。次の巡で見直す
      4) echo "$session: まだ動いているためアーカイブを見送りました" ;;
      *) echo "$session: アーカイブできませんでした: ${out:-理由不明}" ;;
    esac
  done
  ((archived > 0)) && echo "終わったCodexセッションを${archived}件アーカイブしました"
  return 0
}

# Remote Controlのデーモンが落ちていれば起こし直す。
#
# **一度でもRemote Controlを有効にしたホストだけ**（`remoteControlEnabled: true`。「Codexに繋ぐ」の
# `codex remote-control start`が書く）。繋いだことの無いホストでデーモンを勝手に起こさない。
# `start`は上がっていれば`connected`を返すだけ（冪等）だが、`codex`を起こすこと自体が重いので、
# 生きているかはpidとソケットで見て、落ちているときだけ打つ。
codex_remote_control_keepalive() {
  [[ "$CODEX_REMOTE_KEEPALIVE_ENABLED" == "1" ]] || return 0
  local codex_command="${1:-}" home settings pid_file pid socket last now
  [[ -n "$codex_command" && -x "$codex_command" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  home="$(codex_thread_archive_home)"
  settings="$home/app-server-daemon/settings.json"
  [[ -f "$settings" ]] || return 0
  jq -e '.remoteControlEnabled == true' "$settings" >/dev/null 2>&1 || return 0

  pid_file="$home/app-server-daemon/app-server.pid"
  socket="${ISSUE_DECK_CODEX_APP_SERVER_SOCKET:-$home/app-server-control/app-server-control.sock}"
  pid="$(jq -r '.pid // empty' "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && [[ -S "$socket" ]]; then
    return 0
  fi

  last=0
  [[ -f "$CODEX_REMOTE_KEEPALIVE_STAMP" ]] &&
    last="$(date -r "$CODEX_REMOTE_KEEPALIVE_STAMP" +%s 2>/dev/null || echo 0)"
  now="$(date +%s)"
  ((now - last >= CODEX_REMOTE_KEEPALIVE_INTERVAL_MINUTES * 60)) || return 0
  mkdir -p "$(dirname "$CODEX_REMOTE_KEEPALIVE_STAMP")" 2>/dev/null || true
  touch "$CODEX_REMOTE_KEEPALIVE_STAMP" 2>/dev/null || true

  echo "CodexのRemote Controlのデーモンが止まっているため起こし直します..."
  local runner=(setsid)
  command -v setsid >/dev/null 2>&1 || runner=()
  "${runner[@]}" timeout 120 "$codex_command" remote-control start --json >/dev/null 2>&1 &
  disown 2>/dev/null || true
  return 0
}
