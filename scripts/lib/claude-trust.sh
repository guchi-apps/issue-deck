#!/usr/bin/env bash
# Claude Codeのフォルダ信頼確認（`Is this a project you created or one you trust?`）が
# そのリポジトリで済んでいるかを、**読むだけ**で判定する（#1838）。
#
# 誰が使うか:
#   scripts/start-local-session.sh   画面の「サブPCで開始」の受け口。未信頼なら起こす前に止める
#   scripts/generic-start-issue.sh   汎用ランチャー（ターミナル直叩きの経路）
#
# ## なぜ要るか
#
# 初めてClaude Codeを開くリポジトリでは、`claude`の起動直後に信頼確認が出て、答えるまで
# セッションが始まらない。**この間はフックが1つも飛ばない**（#1465）ため、画面には
# 「実行中」と出たまま何も進まず、3分後に「まだ開始していません」が出るまで気付けない。
# しかも答えるにはtmuxへattachするしかなく（Remote Controlはセッションが始まっていないので
# 繋がっていない）、画面から辿れる出口が無い。
#
# 起動する前に分かるなら、止まったセッションを立てるより先に「1回だけ答えてください」と
# 出した方が早い。判定材料は`~/.claude.json`にあり、**読むだけで足りる**。
#
# ## 書き換えない
#
# 「信頼確認そのものは自動化しない」（docs/multi-agent/session-notify.md）という取り決めは
# 変えない。ここは`~/.claude.json`を**読むだけ**で、`hasTrustDialogAccepted`を立てる処理は
# 持たない。答えるのは人。
#
# ## 判定できないときは通す（fail open）
#
# 保存場所やキー名はClaude Code側の都合で変わりうる。**変わったら判定できなくなるだけ**で、
# 起動を止めない。ここで誤って止めると、正常に起動できるリポジトリのセッションが1つも
# 立てられなくなり、症状は元の不具合より重い。
#
# このファイル自体は実行せず、source して使う。

# `~/.claude.json`の場所。`CLAUDE_CONFIG_DIR`を設定している環境ではその直下にある。
claude_trust_config_file() {
  if [[ -n "${CLAUDE_CONFIG_DIR:-}" ]]; then
    printf '%s/.claude.json' "$CLAUDE_CONFIG_DIR"
    return 0
  fi
  printf '%s/.claude.json' "$HOME"
}

# 信頼が記録されるディレクトリを返す。
#
# **worktreeのパスではなく、本体チェックアウトのパスに記録される。** 実測（2026-08-17・サブPC）で
# `~/.claude.json`の`projects`に載っているのは本体チェックアウトと非gitのディレクトリだけで、
# `~/apps/<repo>-worktrees/issue-<番号>`は約100件の会話履歴がある一方で1件も無かった。
# つまり**リポジトリにつき1回答えれば、そのリポジトリのworktreeでは聞かれない**。
#
# 導き方は「共通の.gitの親」。worktreeの`--git-common-dir`は本体の`.git`を指す。
# 取れなければ渡されたパスをそのまま返す（判定が緩む方向に倒れる）。
claude_trust_project_root() {
  local path="$1" common_dir root
  [[ -n "$path" ]] || return 1
  if common_dir="$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" &&
    [[ -n "$common_dir" ]]; then
    root="$(dirname "$common_dir")"
    if [[ -n "$root" && -d "$root" ]]; then
      printf '%s' "$root"
      return 0
    fi
  fi
  printf '%s' "$path"
}

# 信頼確認が済んでいるか。
#
#   0  済んでいる、または判定できない（fail open。呼び出し元は起動してよい）
#   1  済んでいないと確定した（呼び出し元は案内を出して止めてよい）
#
# 「済んでいないと確定」と言えるのは次の2つだけ。それ以外（設定ファイルが無い・壊れている・
# `python3`が無い・キーはあるが`hasTrustDialogAccepted`という項目が無い）は0で返す。
#
#   - `projects`にそのパスのキーが無い（＝一度も開いていない）
#   - キーがあり`hasTrustDialogAccepted`が明示的に`false`
#
# 祖先ディレクトリが信頼済みなら済んでいる扱いにする。親を信頼したときに子で聞かれるかは
# こちらから確かめられないため、**緩い側**へ倒す。
claude_trust_is_trusted() {
  local path="$1" config
  [[ -n "$path" ]] || return 0
  command -v python3 >/dev/null 2>&1 || return 0

  config="$(claude_trust_config_file)"
  [[ -f "$config" ]] || return 0

  # 終了コード: 0=信頼済み / 1=未信頼と確定 / 2=判定不能
  local status=0
  python3 - "$path" "$config" <<'PY' || status=$?
import json
import os
import sys

path, config = sys.argv[1], sys.argv[2]

try:
    with open(config, encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    sys.exit(2)

projects = data.get("projects")
if not isinstance(projects, dict):
    sys.exit(2)

target = os.path.abspath(path)

# 自分自身から順に親をたどる。1つでも信頼済みがあれば信頼済み。
current = target
while True:
    entry = projects.get(current)
    if isinstance(entry, dict) and entry.get("hasTrustDialogAccepted") is True:
        sys.exit(0)
    parent = os.path.dirname(current)
    if parent == current:
        break
    current = parent

entry = projects.get(target)
if isinstance(entry, dict) and "hasTrustDialogAccepted" not in entry:
    # 項目そのものが無い＝こちらの知っている書式ではない。判定できない扱いにする。
    sys.exit(2)

sys.exit(1)
PY

  [[ "$status" == "1" ]] && return 1
  return 0
}

# 未信頼だったときに出す案内。**何を1回だけやればよいか**まで書く。
claude_trust_print_untrusted_error() {
  local root="$1" full_name="${2:-}"
  {
    echo "Error: ${full_name:+$full_name（}$root${full_name:+）}のフォルダ信頼確認がまだ済んでいません。"
    echo "  このまま起こすと、tmuxの中でClaude Codeが"
    echo "  「Is this a project you created or one you trust?」を出したまま止まり、"
    echo "  渡したプロンプトは届きません（#1465・#1838）。"
    echo
    echo "  端末で次を1回だけ実行し、信頼確認に答えてから起動し直してください。"
    echo
    echo "    cd $root && claude"
    echo "    （「Yes, I trust this folder」を選び、/exit で抜ける）"
    echo
    echo "  信頼は本体チェックアウトのパスに記録されるため、リポジトリにつき1回で済みます。"
    echo "  以後このリポジトリのworktreeでは聞かれません。"
    echo
    echo "  判定を飛ばして起こす場合は ISSUE_DECK_SKIP_CLAUDE_TRUST_CHECK=1 を付けてください。"
  } >&2
}

# 判定と案内をまとめたもの。未信頼と確定したときだけ非0で返る。
# `ISSUE_DECK_SKIP_CLAUDE_TRUST_CHECK=1`で丸ごと飛ばせる（判定が誤っていても起動できるように）。
claude_trust_require() {
  local path="$1" full_name="${2:-}" root
  [[ "${ISSUE_DECK_SKIP_CLAUDE_TRUST_CHECK:-0}" == "1" ]] && return 0
  root="$(claude_trust_project_root "$path")" || return 0
  claude_trust_is_trusted "$root" && return 0
  claude_trust_print_untrusted_error "$root" "$full_name"
  return 1
}
