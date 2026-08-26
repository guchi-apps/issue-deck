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
# Claude Code側の連携（`--settings`で注入するフック・`--remote-control`・Plan modeの承認）は
# Codexには無い。**無いものを無理に真似せず、呼び出し側が種別で分岐して素通りする**方針にしている。
# セッションの開始・終了・プレビューURLの報告は`run-issue-session.sh`のラッパー側（フックではない）
# で行っているため、Codexでもそのまま残る。

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

# Codexの起動引数を`AGENT_CLI_ARGS`配列へ組み立てる（プロンプト本文は含めない。呼び出し側が
# 最後の位置引数として渡す）。フラグ名は`codex --help`（openai/codex の SharedCliOptions）に対応する。
#
# 既定は `--sandbox workspace-write` ＋ `--ask-for-approval never`。これは Claude Code の
# `--permission-mode auto`（#1205）に相当する位置づけで、理由も同じ。
#
# - **人が横にいない実行が前提**（サブPC・外出先からの起動）。`on-request`にすると、Codexが承認を
#   求めた時点でセッションが黙って止まる。**Codexにはフックが無く、入力待ちの通知も飛ばない**ので、
#   端末を見に来るまで誰も気づけない
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
# **`--add-dir`は付けない。** Codexの`--add-dir`は「書き込み可能なディレクトリを増やす」もので、
# 読み取りはサンドボックスの外でも可能。共有知識リポジトリ（`~/apps/_docs`）は**読み取り専用**として
# 扱う決まり（CLAUDE.md）なので、渡すとその決まりを機械的に破れるようになってしまう。
agent_cli_build_codex_args() {
  local sandbox="${ISSUE_DECK_CODEX_SANDBOX:-workspace-write}"
  local model="${ISSUE_DECK_CODEX_MODEL:-}"

  AGENT_CLI_ARGS=(--sandbox "$sandbox" --ask-for-approval never)

  if [[ "$sandbox" == "workspace-write" ]]; then
    AGENT_CLI_ARGS+=(-c sandbox_workspace_write.network_access=true)
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
