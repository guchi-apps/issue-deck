#!/usr/bin/env bash
# ローカルセッションで起こすエージェントCLIを選ぶ（#2377）。
#
# scripts/start-issue.sh と scripts/run-issue-session.sh の両方から source する。
# このファイル自体は実行せず、source して使う。
#
# ## なぜ切り替え可能にするか
#
# ローカルセッションは長らく`claude`（Claude Code）を直接起動する前提で書かれてきた。
# ChatGPTのCodex CLI（`codex`）でも同じworktree・同じ実装プロンプトで作業できるようにするため、
# 「どのCLIを起こすか」だけをここに集約し、呼び出し側は種別を1つ受け取るだけにする。
#
# **既定は`claude`のまま。** `ISSUE_DECK_AGENT`を明示したときだけ切り替わる。
#
# ## Codexで揃わないもの（docs/multi-agent/codex.md）
#
# Claude Code側の連携のうち`--remote-control`・Plan modeの承認はCodexには無い。
# **無いものを無理に真似せず、呼び出し側が種別で分岐して素通りする**方針にしている。
# セッションの開始・終了・プレビューURLの報告は`run-issue-session.sh`のラッパー側（フックではない）
# で行っているため、Codexでもそのまま残る。
#
# **フックだけは#2509で揃った。** Codex 0.151.0はフック機能をstableとして持っており、
# 入力のフィールド名（`hook_event_name`）も`session-notify.sh`が読んでいるものと同じ。
# 組み立ては下の`agent_cli_build_codex_hook_args`が持つ。

# 対応している種別。増やすときはここと agent_cli_command_name / agent_cli_display_name を揃える。
AGENT_CLI_KINDS=(claude codex)

# 種別を解決して`AGENT_CLI_KIND`へ入れる。第1引数が空なら`claude`。
# 未対応の値は理由を標準エラーへ書いて1を返す（**黙って既定へ落とさない**。指定したつもりで
# Claudeが起きるより、その場で止まったほうが気づける）。
agent_cli_resolve_kind() {
  local raw="${1:-}"
  local kind

  kind="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  [[ -n "$kind" ]] || kind="claude"

  local known
  for known in "${AGENT_CLI_KINDS[@]}"; do
    if [[ "$kind" == "$known" ]]; then
      AGENT_CLI_KIND="$kind"
      return 0
    fi
  done

  echo "Error: 対応していないエージェントです: $raw（指定できるのは ${AGENT_CLI_KINDS[*]}）" >&2
  return 1
}

# 種別に対応する実行ファイル名。`command -v`の判定と起動の両方で使う。
agent_cli_command_name() {
  case "${1:-claude}" in
    codex) printf 'codex' ;;
    *) printf 'claude' ;;
  esac
}

# 画面・ログに出す表示名。
agent_cli_display_name() {
  case "${1:-claude}" in
    codex) printf 'Codex CLI' ;;
    *) printf 'Claude Code' ;;
  esac
}

# Codexに渡すサンドボックスの実効モード。**起動引数の組み立て（`agent_cli_build_codex_args`）と
# 起動前の下見（`agent_cli_codex_sandbox_probe`）の両方がここを読む。** 別々に既定値を書くと、
# 「下見は通ったのに起動で落ちる」（またはその逆）が起きる。
agent_cli_codex_sandbox_mode() {
  printf '%s' "${ISSUE_DECK_CODEX_SANDBOX:-workspace-write}"
}

# `child`が`parent`と同じか、その下にあれば0を返す。文字列だけで判定する（両方とも呼び出し側が
# 絶対パスに解決してから渡す）。
agent_cli_path_contains() {
  local parent="${1%/}" child="${2%/}"
  [[ -n "$parent" && -n "$child" ]] || return 1
  [[ "$child" == "$parent" || "$child" == "$parent"/* ]]
}

# Codexへ`--add-dir`で渡す、**ワークスペースの外にある書き込み先**を1行ずつ出力する（#2529）。
#
# ## なぜ要るか
#
# git worktreeでは、作業ツリーの`.git`は`gitdir: <本体>/.git/worktrees/<名前>`と書かれた
# **ただのファイル**で、インデックスもHEADもログも本体側のそのディレクトリにある。`workspace-write`の
# サンドボックスが書けるのはcwd（＝worktree）だけなので、**`git add`が
# `index.lock: Read-only file system`で落ちる**。実際に#2511のCodexセッションが、実装と検証を
# 終えたあとコミットの直前で止まった。
#
# 出すのは次の2つのうち、ワークスペースの外にあるもの。
#
#   `--git-common-dir`   本体の`.git`。オブジェクト・`refs/heads/*`・`packed-refs`・`FETCH_HEAD`が
#                        ここにあり、コミットとpushの両方が書く
#   `--absolute-git-dir` このworktreeの管理領域（`…/.git/worktrees/<名前>`）。indexとHEADがある
#
# 通常は後者が前者の下にあるため、**出力は本体の`.git`1つだけ**になる。ふつうのクローン
# （`.git`がワークスペースの中）では**何も出さない**——閉じ込めを緩める理由が無い。
#
# ## 閉じ込めがどこまで緩むか
#
# 本体の`.git`を開けると、他Issueのworktreeの管理領域と他ブランチのrefへも書けるようになる。
# ただし`.git`の外——**本体チェックアウトと他Issueのworktreeの作業ファイル**——は従来どおり
# 読み取り専用のままで、`danger-full-access`（逃げ道。docs/multi-agent/codex.md）とは違う。
# gitはオブジェクトもrefも本体側へ書くため、これより狭くしてコミットとpushを通す方法は無い。
agent_cli_codex_writable_dirs() {
  local workspace="${1:-$PWD}"
  local common_dir git_dir dir chosen
  local -a picked=()

  command -v git >/dev/null 2>&1 || return 0
  [[ -n "$workspace" && -d "$workspace" ]] || return 0

  # gitリポジトリでなければどちらも空になる（`|| true`で`set -e`の下でも止めない）。
  common_dir="$(git -C "$workspace" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  git_dir="$(git -C "$workspace" rev-parse --absolute-git-dir 2>/dev/null || true)"

  # 共通の`.git`を先に見る。linked worktreeの管理領域はその下にあるので、先に採れば2つ目は落ちる。
  for dir in "$common_dir" "$git_dir"; do
    [[ -n "$dir" && -d "$dir" ]] || continue
    if agent_cli_path_contains "$workspace" "$dir"; then
      continue
    fi
    local covered=0
    for chosen in ${picked[@]+"${picked[@]}"}; do
      if agent_cli_path_contains "$chosen" "$dir"; then
        covered=1
        break
      fi
    done
    [[ "$covered" == "0" ]] || continue
    picked+=("$dir")
  done

  for dir in ${picked[@]+"${picked[@]}"}; do
    printf '%s\n' "$dir"
  done
}

# Codexの起動引数を`AGENT_CLI_ARGS`配列へ組み立てる（プロンプト本文は含めない。呼び出し側が
# 最後の位置引数として渡す）。第1引数にセッションUUIDがあれば、先頭へ
# `resume <UUID>`を付ける（#2520）。フラグ名は`codex --help`と`codex resume --help`
# （openai/codex の SharedCliOptions）に対応する。
#
# 既定は `--sandbox workspace-write` ＋ `--ask-for-approval never`。これは Claude Code の
# `--permission-mode auto`（#1205）に相当する位置づけで、理由も同じ。
#
# - **人が横にいない実行が前提**（サブPC・外出先からの起動）。`on-request`にすると、Codexが承認を
#   求めた時点でセッションが黙って止まる。**Codexには入力待ちを知らせるイベントが無い**ので
#   （フックは#2509で繋いだが、`Notification`に当たるものが無い）、端末を見に来るまで誰も気づけない
# - 代わりに失われる「個々のコマンドを人が目視する機会」は、Claude側と同じ後段の防御で受ける
#   （Pull Request必須・`claude-review-develop.yml`のレビュー・自動マージ不可カテゴリ・
#   Issueごとのworktree分離）
# - 書き込みはサンドボックスがworktree（cwd）に閉じるため、無承認でも他のIssueのworktreeや
#   本体チェックアウトへは手が届かない
#
# **`workspace-write`のときはネットワークを明示的に開ける。** Codexのサンドボックスは既定で
# ネットワークを塞ぐため、開けないと`gh issue comment`・`git push`・`pnpm install`が軒並み失敗する。
# 実装セッションはIssueへの報告とPR作成が仕事なので、塞いだままでは成立しない。
#
# **`--add-dir`を渡すのはgitの管理領域だけ**（#2529。下の`agent_cli_codex_writable_dirs`）。
# それ以外には渡さない。Codexの`--add-dir`は「書き込み可能なディレクトリを増やす」もので、
# 読み取りはサンドボックスの外でも可能。共有知識リポジトリ（`~/apps/_docs`）は**読み取り専用**として
# 扱う決まり（CLAUDE.md）なので、渡すとその決まりを機械的に破れるようになってしまう。
#
# 第1引数は再開するスレッド（空なら新規。#2510）、第2引数はワークスペースの根（既定は`$PWD`）。
# 第2引数は`--add-dir`の判定にだけ使う。
agent_cli_build_codex_args() {
  local resume_thread="${1:-}"
  local workspace="${2:-$PWD}"
  local sandbox
  sandbox="$(agent_cli_codex_sandbox_mode)"
  local model="${ISSUE_DECK_CODEX_MODEL:-}"
  local writable_dir

  AGENT_CLI_ARGS=()
  if [[ -n "$resume_thread" ]]; then
    AGENT_CLI_ARGS+=(resume "$resume_thread")
  fi
  AGENT_CLI_ARGS+=(--sandbox "$sandbox" --ask-for-approval never)

  if [[ "$sandbox" == "workspace-write" ]]; then
    AGENT_CLI_ARGS+=(-c sandbox_workspace_write.network_access=true)
    # `workspace-write`のときだけ足す。`read-only`は書けないのが目的で、
    # `danger-full-access`は元から全部書けるので、どちらも足す意味がない。
    while IFS= read -r writable_dir; do
      [[ -n "$writable_dir" ]] || continue
      AGENT_CLI_ARGS+=(--add-dir "$writable_dir")
    done < <(agent_cli_codex_writable_dirs "$workspace")
  fi

  if [[ -n "$model" ]]; then
    AGENT_CLI_ARGS+=(-m "$model")
  fi

  # 逃げ道（#2377）。**実機でしか分からない調整をスクリプトの修正なしで当てるため**に置く。
  # 空白区切りで分割するので、空白を含む値は渡せない（渡したい場合はこのファイルを直す）。
  if [[ -n "${ISSUE_DECK_CODEX_EXTRA_ARGS:-}" ]]; then
    # shellcheck disable=SC2206 # 空白区切りで分割したいので意図的にクォートしない
    local extra=(${ISSUE_DECK_CODEX_EXTRA_ARGS})
    AGENT_CLI_ARGS+=("${extra[@]}")
  fi

  return 0
}

# 起動前にサンドボックスを組み立てられるか下見する（#2526）。判定結果を**1行目**に、
# 判定の材料（codexが出したエラーの1行目）を**2行目以降**に出す。終了コードは常に0。
#
#   ok       そのモードでサンドボックスを組み立てられた
#   broken   組み立てに失敗した。そのまま起こしてもコマンドを1本も実行できない
#   unknown  判定できなかった（`codex`が無い・`codex sandbox`を持たない版）
#
# ## なぜ要るか
#
# Ubuntu 24.04の既定（`kernel.apparmor_restrict_unprivileged_userns = 1`）は、非特権の
# user namespace の中でcapabilityを全部落とす。Codexが同梱するbubblewrapはそこでサンドボックスを
# 組み立てられず、**`codex`コマンド自体は入っているのにセッションが即死する**（#2526。subpcで実際に
# 起きた。ホスト側の恒久対処は guchi-apps/subpc#77）。`command -v codex`だけでは、この状態と
# 正常なホストを区別できない。
#
# ## `--sandbox`ではなく`-c sandbox_mode=`で渡す
#
# `codex sandbox`サブコマンドは`--sandbox`も`--ask-for-approval`も受け取らない（`-c`の
# オーバーライドだけ）。モードとネットワークの指定は`agent_cli_build_codex_args`と同じ値を使う。
# **`ISSUE_DECK_CODEX_EXTRA_ARGS`は渡さない**——あれはTUIへの引数で、ここへ持ち込むと
# 下見だけが不正な引数で落ちる。
#
# ## 判定できないときは`unknown`（＝塞がない）
#
# `codex sandbox`を持たない版では材料が無い。そこを`broken`にすると、動くかもしれないホストで
# Codexを選べなくなる。**証拠があるときだけ塞ぐ。**
agent_cli_codex_sandbox_probe() {
  local mode output probe_args timeout_args=()

  if ! command -v codex >/dev/null 2>&1; then
    printf 'unknown'
    return 0
  fi

  # 下見が固まるとpollerの1巡ごと止まる（`codex_capable`は申告のたびに呼ばれる）。
  # `timeout`が無い環境では付けない（下見のために起動を諦めるほうが重い）。
  if command -v timeout >/dev/null 2>&1; then
    timeout_args=(timeout 10)
  fi

  if ! "${timeout_args[@]}" codex sandbox --help >/dev/null 2>&1; then
    printf 'unknown'
    return 0
  fi

  mode="$(agent_cli_codex_sandbox_mode)"
  probe_args=(-c "sandbox_mode=$mode")
  if [[ "$mode" == "workspace-write" ]]; then
    probe_args+=(-c sandbox_workspace_write.network_access=true)
  fi

  if output="$("${timeout_args[@]}" codex sandbox "${probe_args[@]}" -- /bin/true 2>&1)"; then
    printf 'ok'
    return 0
  fi

  # 材料として返すのは最初の非空行だけ。`bwrap: setting up uid map: Permission denied`のような
  # 1行がそのまま「ホストのuserns制限」の目印になる（docs/multi-agent/codex.md）。
  printf 'broken\n%s' "$(printf '%s\n' "$output" | grep -m1 -v '^[[:space:]]*$' || true)"
  return 0
}

# 下見の結果（`agent_cli_codex_sandbox_probe`の出力）から判定だけを取り出す。
agent_cli_codex_sandbox_probe_state() {
  printf '%s' "${1%%$'\n'*}"
}

# 下見の結果から材料の行だけを取り出す（無ければ空）。
agent_cli_codex_sandbox_probe_reason() {
  local probe="${1:-}"
  [[ "$probe" == *$'\n'* ]] || return 0
  printf '%s' "${probe#*$'\n'}"
}

# Codexの読み替え（`scripts/prompts/codex-supplement.md`）を、生成済みのプロンプトの末尾へ足す。
#
# 第1引数は読み替えのファイル、第2引数は追記先のプロンプト、第3引数は**実際に走らせる
# `scripts/`の絶対パス**（`LAUNCHER_SCRIPTS_DIR`）。
#
# ## なぜパスを差し込むか（#2590）
#
# 読み替えは`submit-plan.sh`・`submit-question.sh`の実行を指示するが、**この2つはissue-deckの
# スクリプトで、対象リポジトリのworktreeには無い。** 汎用ランチャー（#1224）で起こすセッションの
# cwdは他リポジトリのworktreeなので、`scripts/submit-plan.sh`と相対で書くと必ず外れる。
# そのため`{{ISSUE_DECK_SCRIPTS_DIR}}`を置いておき、ここで絶対パスへ直す。
#
# **issue-deck自身のセッションでも同じ絶対パスにする。** 走らせるのはworktree側の写しではなく、
# セッション側のスクリプト（`run-issue-session.sh`・フック）と同じ同期コピー（#1438）で揃える。
agent_cli_append_codex_supplement() {
  local supplement="${1:-}" prompt_file="${2:-}" scripts_dir="${3:-}"

  [[ -f "$supplement" && -f "$prompt_file" ]] || return 1

  printf '\n' >>"$prompt_file"
  AGENT_CLI_SUPPLEMENT_SCRIPTS_DIR="$scripts_dir" python3 - "$supplement" >>"$prompt_file" <<'PY'
import os
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    body = f.read()
sys.stdout.write(
    body.replace(
        "{{ISSUE_DECK_SCRIPTS_DIR}}", os.environ.get("AGENT_CLI_SUPPLEMENT_SCRIPTS_DIR", "scripts")
    )
)
PY
}

# ---------------------------------------------------------------------------
# Codexのフック（#2509）
#
# Codexのフックは Claude Code とほぼ同じ形をしている。stdinに来るJSONの共通フィールドは
# `session_id` / `transcript_path` / `cwd` / `hook_event_name` / `model` / `permission_mode`で、
# `PostToolUse`には`tool_name` / `tool_input` / `tool_use_id` / `turn_id`が付く。
# **`session-notify.sh`が読んでいる名前とそのまま一致する**ので、通知スクリプトは流用できる。
#
# ## 設定は`-c`のオーバーライドで渡す（ファイルには置かない）
#
# フック設定を置ける層は3つあるが、**このセッションにだけ効かせられるのは`-c`だけ**（実測。
# 0.151.0）。
#
#   `~/.codex/hooks.json`     ユーザー層。**そのホストの全Codexセッション**に効いてしまう
#   `<worktree>/.codex/…`     プロジェクト層。リポジトリの中なのでコミットの事故が起きうる
#   `-c hooks.<イベント>=…`   このプロセスだけ。**worktree単位の分離がそのまま得られる**
#
# `ps`にフックのコマンドが出るのはClaude側（`--settings`でファイル渡し）と違う点だが、
# 出るのは`session-notify.sh`のパスとIssue番号・リポジトリ名だけで、Codexの起動は元々
# キックオフのプロンプト全文を位置引数に載せている。
#
# ## 信頼（trust）は2種類ある。両方を越えないとフックは1つも飛ばない
#
#   1. **フックの信頼**: 非管理フックは人がレビューして信頼するまで実行されない。信頼は
#      フック定義のハッシュに紐づくため、Issueごとに変わる引数（番号）を含むこの用途では
#      毎回「新しいフック」になる。`--dangerously-bypass-hook-trust`で越える（下記）
#   2. **ディレクトリの信頼**: 初めて開くディレクトリでは起動直後に
#      `Do you trust the contents of this directory?`が出て、答えるまで**`SessionStart`すら
#      飛ばない**（実測）。Claude Codeと違い**worktreeのパスごとに記録される**ため
#      （`~/.codex/config.toml`の`[projects."<絶対パス>"]`）、Issueごとに1回聞かれる。
#      ここは自動化しない（docs/multi-agent/session-notify.md「信頼確認そのものは自動化しない」）
#
# ## `--dangerously-bypass-hook-trust`を選ぶ理由と、その代償の受け方
#
# 管理フック扱い（`requirements.toml`）にする道もあるが、あれはホスト全体へ効く管理設定で、
# 置いた時点でCodexのフックの信頼レビューがこのホストから丸ごと消える。**このフラグなら
# 効果はこの1プロセスに閉じる。**
#
# 代償は「そのプロセスで有効なフックが**全部**レビュー無しで走る」こと。ディレクトリを信頼すると
# プロジェクト層（`<worktree>/.codex/`）のフックも読まれるため、リポジトリが同梱したフックが
# 混ざりうる。そこで**worktreeがプロジェクト層のフック設定を持っているときはフックを有効にしない**
# （`agent_cli_codex_project_hook_file`。呼び出し側が判定して素通りする）。
# ---------------------------------------------------------------------------

# 画面連携を繋ぐイベント（#2509）。
#
# **`PostToolUse`は繋がない。** `session-notify.sh`のあのイベントは「人が承認プロンプトに
# 答えて作業へ戻った」ことを拾うためのもので、直前の状態が`permission_prompt`のときしか
# 報告しない。Codexは`--ask-for-approval never`で走らせるため承認プロンプトが出ず、
# `permission_prompt`を書き込む経路（Claudeの`Notification`・`ExitPlanMode`・`AskUserQuestion`）が
# どれも無い。繋いでもツール実行のたびにプロセスを起こして必ず捨てるだけになる。
AGENT_CLI_CODEX_HOOK_EVENTS=(SessionStart Stop)

# TOMLの基本文字列（`"…"`）へ入れられる形に直す。エスケープが要るのは`\`と`"`だけ。
agent_cli_toml_escape() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

# worktreeがプロジェクト層のフック設定を持っていれば、そのパスを出力して0を返す。
#
# **持っていたら呼び出し側はフックを有効にしない。** `--dangerously-bypass-hook-trust`は
# 「このプロセスで有効なフックを全部レビュー無しで走らせる」フラグなので、リポジトリ同梱の
# フックがある状態で付けると、それも一緒に無検査で走る。画面連携を諦めるほうが軽い。
agent_cli_codex_project_hook_file() {
  local dir="${1:-}" candidate
  [[ -n "$dir" ]] || return 1
  for candidate in "$dir/.codex/hooks.json" "$dir/.codex/config.toml"; do
    if [[ -e "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# フックの起動引数を`AGENT_CLI_HOOK_ARGS`配列へ組み立てる。
#
# 第1引数は**シェルのコマンド行**（Codexは`command`の文字列をシェルの規則で分割する。実測で
# `'…/session-notify.sh' '2509' 'issue-deck' 'guchi-apps/issue-deck'`が引数3つとして届く）。
# コマンド行が空なら何も組み立てずに1を返す。
agent_cli_build_codex_hook_args() {
  local command_line="${1:-}" event escaped

  AGENT_CLI_HOOK_ARGS=()
  [[ -n "$command_line" ]] || return 1

  escaped="$(agent_cli_toml_escape "$command_line")"
  AGENT_CLI_HOOK_ARGS=(--dangerously-bypass-hook-trust)
  for event in "${AGENT_CLI_CODEX_HOOK_EVENTS[@]}"; do
    AGENT_CLI_HOOK_ARGS+=(-c "hooks.$event=[{hooks=[{type=\"command\",command=\"$escaped\"}]}]")
  done

  return 0
}
