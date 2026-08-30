#!/usr/bin/env bash
# Pull Requestを人の指示で作るリポジトリかどうかの判定（#2499）。
#
# 一覧の正は `scripts/local-repo-pr-policy.conf`。**判定を持つのはこのファイルだけ**にする。
# 起動プロンプト（`scripts/generic-start-issue.sh`）とセッションの回収
# （`scripts/reap-sessions.sh`）の2か所が読むが、片方だけが手動と判定すると、
# 「PRを作らないのに畳まれる」「PRを作るのに畳まれない」のどちらかになって噛み合わない。
#
# `local-repo-resolve.sh` から独立させてあるのは、回収スクリプトが起動判定のライブラリ
# （複製先での実行やパッケージマネージャの検出まで抱えている）を読む必要が無いため。
# confの探索順だけは `local_repo_ports_config_file` と同じ形に揃えてある。

# このライブラリと同じ場所に配られているファイルを指す（リポジトリ内なら `scripts/`、
# 同期コピーなら `~/.cache/issue-deck/launcher-scripts/<SHA>/scripts/`）。
_pr_policy_share_dir() {
  (cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
}

pr_policy_config_file() {
  local candidate
  for candidate in \
    "${ISSUE_DECK_LOCAL_REPO_PR_POLICY_CONFIG:-}" \
    "$(_pr_policy_share_dir)/local-repo-pr-policy.conf" \
    "$HOME/.config/issue-deck/local-repo-pr-policy.conf"; do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

# `<owner>/<repo>` がPRを人の指示で作るリポジトリなら0を返す。
#
# **confが無い・読めないときは「手動ではない」（＝従来どおり）へ倒す。** 読めなかったことを
# 手動扱いにすると、一覧に載っていない全リポジトリのセッションが畳まれなくなり、同時実行数の
# 枠を埋めたまま気付けない。
pr_policy_is_manual() {
  local target="$1" config_file line name policy
  [[ -n "$target" ]] || return 1
  config_file="$(pr_policy_config_file)" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*([^[:space:]]+)[[:space:]]+([A-Za-z]+)[[:space:]]*$ ]] || continue
    name="${BASH_REMATCH[1]}"
    policy="${BASH_REMATCH[2]}"
    [[ "$name" == "$target" ]] || continue
    [[ "$policy" == "manual" ]] && return 0
    return 1
  done <"$config_file"
  return 1
}
