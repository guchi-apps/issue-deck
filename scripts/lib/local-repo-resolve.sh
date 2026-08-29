#!/usr/bin/env bash
# ローカルセッション起動の「どのリポジトリを起動できるか」の判定（#1179）。
#
# `scripts/start-local-session.sh`（画面のワンクリック起動の受け口）と
# `scripts/subpc-dispatch-poller.sh`（サブPCのディスパッチpoller）が共有する。
#
# **判定を二重に持たない**ためにここへ寄せている。pollerは「自分が実行できるリポジトリ」を
# issue-deckへ申告し、issue-deck側はその一覧を信じてジョブを割り当てる。申告の判定と実際の
# 起動時の判定がずれると、「申告どおりに投げたのに起動しない」という最悪の形で表面化する。
#
# ## 起動方式は2つある（#1224）
#
# | 方式 | 使う実体 | 対象 |
# | --- | --- | --- |
# | contract | 対象リポジトリの `scripts/start-issue.sh`（マーカー行を宣言しているもの） | issue-deck自身 |
# | generic | issue-deck側の `scripts/generic-start-issue.sh`（汎用ランチャー） | それ以外 |
#
# マーカー行（ローカル起動プロトコル・#1073）は**起動できることの必要条件ではなくなった**。
# 宣言しているリポジトリは自前のスクリプトで、していないリポジトリは汎用ランチャーで起動する。
# 対象リポジトリを1つ増やすたびに700行のスクリプトを移植する運用に見合わないため
# （docs/multi-agent/generic-launcher.md）。
#
# ## 複製されて使われる
#
# 受け口は `register-issuedeck-protocol.ps1` によって
# `~/.local/share/issue-deck/start-local-session.sh` へ複製される（#1076）。
# **このファイルも同じ場所の `lib/` へ複製される**。したがって参照は
# `$(dirname "${BASH_SOURCE[0]}")/lib/local-repo-resolve.sh` という相対位置で行い、
# リポジトリ内（`scripts/lib/`）と複製先（`~/.local/share/issue-deck/lib/`）の
# どちらでも同じ1行で解決できるようにしている。
#
# ここにリポジトリのファイルを直接参照する処理を足さないこと。複製先には
# リポジトリのチェックアウトが無い（あっても別Issueのブランチに切り替わっている）。

# 受け口が扱えるローカル起動プロトコルの上限版数。
# src/lib/local-session.ts の LOCAL_SESSION_CONTRACT_VERSION と揃える。
# 複製先からは src/ を読めないため、ここは数字で持つしかない。
LOCAL_SESSION_SUPPORTED_CONTRACT_VERSION=2

# リポジトリ→ローカルのチェックアウト先の対応表。
# 書式は `owner/repo<空白>絶対パス`（`#`始まりはコメント）。scripts/local-repos.conf.example 参照。
local_repos_config_file() {
  printf '%s\n' "${ISSUE_DECK_LOCAL_REPOS_CONFIG:-$HOME/.config/issue-deck/local-repos.conf}"
}

# このライブラリと同じ場所に配られているファイルを指す（リポジトリ内なら `scripts/`、
# 複製先なら `~/.local/share/issue-deck/`）。**リポジトリのチェックアウトを前提にしない**。
local_session_share_dir() {
  (cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
}

# 汎用ランチャー（#1224）。マーカー行を宣言していないリポジトリはこれで起動する。
#
# **複製先（`~/.local/share/issue-deck/`）には配られていない場合がある。** そのときは
# 従来どおりマーカー行を必須とする側に落ちる（「このPC」経由の起動は#1224の対象外で、
# 増やすのはサブPCからの起動だけ）。存在しないまま`ok`にすると、押した先で
# 「ランチャーが無い」と言われるだけになる。
local_repo_generic_launcher() {
  printf '%s\n' "$(local_session_share_dir)/generic-start-issue.sh"
}

# 開発サーバーのポート帯（ベース値）の対応表。**どのリポジトリがどの帯を使うかは定義上
# どのリポジトリ単独でも決められない**ため、全リポジトリを知るissue-deck側が持つ（#1073）。
# 元は受け口の`case`文だったが、対象リポジトリが増えたので設定ファイルへ移した（#1224）。
local_repo_ports_config_file() {
  local candidate
  for candidate in \
    "${ISSUE_DECK_LOCAL_REPO_PORTS_CONFIG:-}" \
    "$(local_session_share_dir)/local-repo-ports.conf" \
    "$HOME/.config/issue-deck/local-repo-ports.conf"; do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

# 対応表の1行を読む共通部分。`<owner>/<repo> <ベース値> [<帯の幅>]`にだけ一致する。
# 3列目（帯の幅・#2478）は省略でき、省略時は何も返さない（既定は呼び出し側が決める）。
# 一致した行の値を第2引数（1=ベース値・2=帯の幅）で選んで返す。
local_repo_port_field() {
  local target="$1" field="$2" config_file line name
  config_file="$(local_repo_ports_config_file)" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*([^[:space:]]+)[[:space:]]+([0-9]+)([[:space:]]+([0-9]+))?[[:space:]]*$ ]] || continue
    name="${BASH_REMATCH[1]}"
    if [[ "$name" == "$target" ]]; then
      if [[ "$field" == "2" ]]; then
        [[ -n "${BASH_REMATCH[4]}" ]] || return 1
        printf '%s\n' "${BASH_REMATCH[4]}"
      else
        printf '%s\n' "${BASH_REMATCH[2]}"
      fi
      return 0
    fi
  done <"$config_file"
  return 1
}

# 対応表からポート帯のベース値を引く。載っていなければ何も返さない
# （そのリポジトリの既定に任せる。勝手な値を渡すと帯が二重管理になる）。
local_repo_port_base() {
  local_repo_port_field "$1" 1
}

# 対応表からポート帯の幅を引く（#2478）。3列目が無ければ何も返さない
# （原則の幅1000は採番側の既定に任せる。ここで埋めると幅が二重管理になる）。
local_repo_port_width() {
  local_repo_port_field "$1" 2
}

# 対象リポジトリが必要とするパッケージマネージャを判定する。リポジトリごとに違うため
# （issue-deck・dayspanはpnpm、他はnpm）、pnpmを無条件に必須化すると壊れる。判定は
# 宣言 → ロックファイル → package.json の順で確からしいものを採る。
# Node系でないリポジトリでは何も返さない（何も要求しない）。
detect_package_manager() {
  local dir="$1"
  if [[ -f "$dir/package.json" ]]; then
    local declared
    declared="$(grep -oP '"packageManager"\s*:\s*"\K[a-z]+' "$dir/package.json" | head -1 || true)"
    if [[ -n "$declared" ]]; then
      printf '%s\n' "$declared"
      return 0
    fi
  fi
  if [[ -f "$dir/pnpm-lock.yaml" ]]; then printf 'pnpm\n'; return 0; fi
  if [[ -f "$dir/yarn.lock" ]]; then printf 'yarn\n'; return 0; fi
  if [[ -f "$dir/bun.lockb" || -f "$dir/bun.lock" ]]; then printf 'bun\n'; return 0; fi
  if [[ -f "$dir/package-lock.json" || -f "$dir/package.json" ]]; then printf 'npm\n'; return 0; fi
  printf '\n'
}

# owner・repo・Issue番号の検証。引数はブラウザやHTTPのレスポンス経由で外部から渡りうるため、
# 呼び出し元で検証済みでも改めて検証する（多層防御。片側の検証が緩んでもここで止まる）。
# 文字集合は src/lib/local-session.ts の OWNER_OR_REPO_PATTERN と揃える。
local_session_validate_target() {
  local owner="$1" repo="$2" issue_number="$3"

  if [[ ! "$owner" =~ ^[A-Za-z0-9._-]+$ || ! "$repo" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Error: owner・repoに使えない文字が含まれています: $owner/$repo" >&2
    return 1
  fi
  # `.`を許可しているため `.` `..` 自体が通る。パスの一部として使うので明示的に弾く。
  if [[ "$owner" =~ ^\.+$ || "$repo" =~ ^\.+$ ]]; then
    echo "Error: owner・repoにディレクトリ参照は指定できません: $owner/$repo" >&2
    return 1
  fi
  if [[ ! "$issue_number" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: issue番号は正の整数で指定してください: $issue_number" >&2
    return 1
  fi
  return 0
}

# 対応表からチェックアウト先を引く。見つからなければ1を返す。
local_repo_resolve_path() {
  local target="$1"
  local config_file
  config_file="$(local_repos_config_file)"

  if [[ -f "$config_file" ]]; then
    local line name path
    # `read -r name path _` だとパスが空白で切れるため、1行読んで最初の空白で2分割する。
    # 併せてCRLFの改行と行末の空白も落とす（Windows側のエディタで編集されうるため）。
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
      [[ "$line" =~ ^[[:space:]]*([^[:space:]]+)[[:space:]]+(.+)$ ]] || continue
      name="${BASH_REMATCH[1]}"
      path="${BASH_REMATCH[2]}"
      path="${path%"${path##*[![:space:]]}"}"
      if [[ "$name" == "$target" ]]; then
        # 設定ファイル側の `~` はシェル展開されないため自前で展開する。
        printf '%s\n' "${path/#\~/$HOME}"
        return 0
      fi
    done <"$config_file"
  fi
  if [[ "$target" == "guchi-apps/issue-deck" ]]; then
    printf '%s\n' "$HOME/apps/issue-deck"
    return 0
  fi
  return 1
}

# start-issue.sh の冒頭マーカーから、宣言されているプロトコル版数を読む。
# パターンは src/lib/local-session.ts の LOCAL_SESSION_MARKER_PATTERN と揃える。
local_repo_declared_contract_version() {
  grep -oP '^#\s*issue-deck-local-session:\s*v\K[0-9]+' "$1" 2>/dev/null | head -1 || true
}

# リポジトリが「いま起動できる」かを判定する。
#
# 結果は次のグローバルへ入れる（複数の値を返すため。サブシェルを挟むと呼び出し側で使えない）。
#   LOCAL_REPO_STATUS   ok | not_configured | missing_dir | no_launcher | no_contract | contract_too_new
#   LOCAL_REPO_PATH     チェックアウト先（解決できた場合）
#   LOCAL_REPO_LAUNCHER 実際に起動するスクリプト（方式によって中身が変わる）
#   LOCAL_REPO_MODE     contract（対象リポジトリのstart-issue.sh） | generic（汎用ランチャー）
#   LOCAL_REPO_VERSION  宣言されている版数（読めた場合）
#
# ok のときだけ 0 を返す。
local_repo_check() {
  local full_name="$1"
  LOCAL_REPO_STATUS=""
  LOCAL_REPO_PATH=""
  LOCAL_REPO_LAUNCHER=""
  LOCAL_REPO_MODE=""
  LOCAL_REPO_VERSION=""

  if ! LOCAL_REPO_PATH="$(local_repo_resolve_path "$full_name")"; then
    LOCAL_REPO_STATUS="not_configured"
    return 1
  fi
  if [[ ! -d "$LOCAL_REPO_PATH" ]]; then
    LOCAL_REPO_STATUS="missing_dir"
    return 1
  fi

  local repo_launcher="$LOCAL_REPO_PATH/scripts/start-issue.sh"
  if [[ -f "$repo_launcher" ]]; then
    LOCAL_REPO_VERSION="$(local_repo_declared_contract_version "$repo_launcher")"
  fi

  # マーカー行を宣言しているリポジトリは、これまでどおり自前のスクリプトで起動する。
  # 自前で起動元の事情（LANアクセス設定・ポート帯・devサーバー）を吸収する約束をしており、
  # 汎用ランチャーへ回すと**そのリポジトリが持つ手当てを黙って捨てる**ことになる。
  if [[ -n "$LOCAL_REPO_VERSION" ]]; then
    if [[ "$LOCAL_REPO_VERSION" -gt "$LOCAL_SESSION_SUPPORTED_CONTRACT_VERSION" ]]; then
      LOCAL_REPO_LAUNCHER="$repo_launcher"
      LOCAL_REPO_STATUS="contract_too_new"
      return 1
    fi
    LOCAL_REPO_LAUNCHER="$repo_launcher"
    LOCAL_REPO_MODE="contract"
    LOCAL_REPO_STATUS="ok"
    return 0
  fi

  # 宣言が無いリポジトリは汎用ランチャーで起動する（#1224）。ランチャーが配られていない
  # 環境（複製先の受け口）では、従来どおりマーカー行が無いことを理由に止める。
  local generic_launcher
  generic_launcher="$(local_repo_generic_launcher)"
  if [[ -f "$generic_launcher" ]]; then
    LOCAL_REPO_LAUNCHER="$generic_launcher"
    LOCAL_REPO_MODE="generic"
    LOCAL_REPO_STATUS="ok"
    return 0
  fi

  LOCAL_REPO_LAUNCHER="$repo_launcher"
  if [[ ! -f "$repo_launcher" ]]; then
    LOCAL_REPO_STATUS="no_launcher"
  else
    LOCAL_REPO_STATUS="no_contract"
  fi
  return 1
}

# local_repo_check の結果を人が読める形で標準エラーへ出す。
# **黙って失敗させない**（何を直せばよいかまで出す）のがこの受け口の約束。
local_repo_print_error() {
  local full_name="$1"
  local repo="${full_name#*/}"
  local config_file
  config_file="$(local_repos_config_file)"

  case "$LOCAL_REPO_STATUS" in
    not_configured)
      echo "Error: $full_name のローカルチェックアウト先が分かりません。" >&2
      echo "  $config_file に次の形式で追記してください:" >&2
      echo "    $full_name /home/$(whoami)/apps/$repo" >&2
      ;;
    missing_dir)
      echo "Error: $full_name のチェックアウト先が存在しません: $LOCAL_REPO_PATH" >&2
      ;;
    no_launcher | no_contract)
      # 汎用ランチャー（#1224）が配られていれば、ここには来ない。来るのは複製先の受け口
      # （「このPC」経由の起動）だけなので、案内も複製先向けに書く。
      echo "Error: $full_name はこの経路では起動できません。" >&2
      echo "  $LOCAL_REPO_LAUNCHER にローカル起動プロトコルのマーカー行がなく、" >&2
      echo "  汎用ランチャー（$(local_repo_generic_launcher)）も配られていません。" >&2
      echo "  「このPC」経由の起動を使う場合は、対象リポジトリの scripts/start-issue.sh の冒頭に" >&2
      echo "  次の1行を足し、約束を満たすようにしてください:" >&2
      echo "    # issue-deck-local-session: v$LOCAL_SESSION_SUPPORTED_CONTRACT_VERSION" >&2
      echo "  約束の内容は issue-deck の docs/multi-agent/local-quick-start.md を参照してください。" >&2
      echo "  サブPCからの起動であれば、issue-deckのチェックアウトを最新化すれば汎用ランチャーで起動できます" >&2
      echo "  （docs/multi-agent/generic-launcher.md）。" >&2
      ;;
    contract_too_new)
      echo "Error: $full_name が宣言する v$LOCAL_REPO_VERSION は、この受け口が扱える v$LOCAL_SESSION_SUPPORTED_CONTRACT_VERSION より新しいです。" >&2
      echo "  issue-deck側を更新してから、register-issuedeck-protocol.ps1 を再実行してください。" >&2
      ;;
    *)
      echo "Error: $full_name の状態を判定できませんでした。" >&2
      ;;
  esac
}

# 同じ内容を1行で返す（ディスパッチのジョブ結果として画面へ返すため。改行を含めない）。
local_repo_status_summary() {
  local full_name="$1"
  case "$LOCAL_REPO_STATUS" in
    ok)
      if [[ "$LOCAL_REPO_MODE" == "generic" ]]; then
        printf '%s\n' "$full_name は起動できます（$LOCAL_REPO_PATH・汎用ランチャー）"
      else
        printf '%s\n' "$full_name は起動できます（$LOCAL_REPO_PATH・v$LOCAL_REPO_VERSION）"
      fi
      ;;
    not_configured) printf '%s\n' "$full_name のチェックアウト先が対応表にありません（$(local_repos_config_file)）" ;;
    missing_dir) printf '%s\n' "$full_name のチェックアウト先が存在しません: $LOCAL_REPO_PATH" ;;
    no_launcher | no_contract) printf '%s\n' "$full_name はこの経路では起動できません（マーカー行も汎用ランチャーもありません）" ;;
    contract_too_new) printf '%s\n' "$full_name が宣言する v$LOCAL_REPO_VERSION は、この受け口が扱える v$LOCAL_SESSION_SUPPORTED_CONTRACT_VERSION より新しいです" ;;
    *) printf '%s\n' "$full_name の状態を判定できませんでした" ;;
  esac
}

# 対応表に載っているリポジトリ名を列挙する（フォールバックのissue-deckを含む）。
local_repo_list_names() {
  local config_file line name
  config_file="$(local_repos_config_file)"
  {
    if [[ -f "$config_file" ]]; then
      while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
        [[ "$line" =~ ^[[:space:]]*([^[:space:]]+)[[:space:]]+(.+)$ ]] || continue
        printf '%s\n' "${BASH_REMATCH[1]}"
      done <"$config_file"
    fi
    # 対応表が無くても解決できる唯一のリポジトリ（resolve_repo_path のフォールバック）
    printf '%s\n' "guchi-apps/issue-deck"
  } | sort -u
}

# 「いま実行できる」リポジトリだけを列挙する。ディスパッチの申告はこれを使う。
local_repo_list_runnable() {
  local name
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if local_repo_check "$name"; then
      printf '%s\n' "$name"
    fi
  done < <(local_repo_list_names)
}
