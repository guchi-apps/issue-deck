#!/usr/bin/env bash
# 起動プロンプトへ差し込む「今の状況」を集める（#1267）。
#
# **判断はしない。事実だけを集める。** LLMを使わない計器の側
# （[docs/multi-agent/gates.md](../../docs/multi-agent/gates.md)）で、俯瞰の情報は要るが
# 俯瞰する常駐の人格は要らない、という整理に従う。差し込むのは計画・着手・PR作成の3点だけなので、
# セッションの起動時に1回集めれば足りる。
#
# **どの関数も失敗しても起動を止めない。** 集まらなければその旨を書いて先へ進む。

# 親子Issueを1行ずつ返す（#1267）。子Issueを起こしたときに親の背景が丸ごと落ちるのを防ぐ。
# `gh issue view --json parent,subIssues` が使えない古いghでは空を返す。
prompt_context_relations() {
  local repo="$1" issue_number="$2" json
  json="$(gh issue view "$issue_number" --repo "$repo" --json parent,subIssues 2>/dev/null || true)"
  if [[ -z "$json" ]]; then
    printf '（取得できませんでした）'
    return 0
  fi
  printf '%s' "$json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("（取得できませんでした）")
    raise SystemExit(0)

lines = []
parent = d.get("parent")
if isinstance(parent, dict) and parent.get("number"):
    lines.append(f'"'"'- 親: #{parent["number"]} {parent.get("title", "")}（{parent.get("state", "")}）'"'"')
subs = (d.get("subIssues") or {}).get("nodes") or []
for sub in subs:
    if isinstance(sub, dict) and sub.get("number"):
        lines.append(f'"'"'- 子: #{sub["number"]} {sub.get("title", "")}（{sub.get("state", "")}）'"'"')

print("\n".join(lines) if lines else "(親子関係のあるIssueはありません)")
' 2>/dev/null || printf '（取得できませんでした）'
}

# 並行して動いているもの（#1267）。developの先端・未マージPR・同じホストの他セッション。
#
# **止めるためではなく見せるため**の情報（gates.md）。無関係なマージのたびに詰まるのを避ける。
# 第3引数にworktreeのパスを渡すと、そこを基準にgitを叩く。
prompt_context_concurrent() {
  local repo="$1" issue_number="$2" worktree="${3:-$PWD}"
  local base_branch="${4:-develop}"
  local out=""

  local tip
  tip="$(git -C "$worktree" log --oneline -1 "origin/$base_branch" 2>/dev/null || true)"
  if [[ -n "$tip" ]]; then
    out+="- \`origin/$base_branch\`の先端: \`$tip\`"$'\n'
  else
    out+="- \`origin/$base_branch\`の先端: （取得できませんでした）"$'\n'
  fi

  local prs
  prs="$(gh pr list --repo "$repo" --base "$base_branch" --state open \
    --json number,title,headRefName --limit 20 2>/dev/null |
    python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
for pr in rows:
    print(f'"'"'- 未マージPR #{pr["number"]} {pr.get("title","")}（`{pr.get("headRefName","")}`）'"'"')
' 2>/dev/null || true)"
  if [[ -n "$prs" ]]; then
    out+="$prs"$'\n'
  else
    out+="- 未マージのdevelop向けPR: なし"$'\n'
  fi

  # 同じホストで走っている他セッション。**tmuxのメタデータだけを読む**（画面の内容は読まない。
  # 文字列からの推定は実地で誤判定した実績がある。gates.md）
  local sessions
  sessions="$(tmux list-sessions -F '#S' 2>/dev/null |
    grep -v -x "$(tmux display-message -p '#S' 2>/dev/null || echo '')" |
    grep -E -- '-issue-[0-9]+$' || true)"
  if [[ -n "$sessions" ]]; then
    while IFS= read -r name; do
      [[ -n "$name" ]] && out+="- 他セッション: \`$name\`"$'\n'
    done <<<"$sessions"
  else
    out+="- 同じホストの他セッション: なし"$'\n'
  fi

  printf '%s' "$out"
}
