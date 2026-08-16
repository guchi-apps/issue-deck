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
#
# **`gh issue view --json parent,subIssues` は使わない**（#1753）。このフィールドは新しめの`gh`に
# しか無く、Ubuntuのapt版（2.45.0）では`Unknown JSON field: "parent"`で落ちる。エラーを握り潰して
# いたため、親子があっても常に「（取得できませんでした）」になっていた。GraphQLのAPI自体は同じ
# `gh`でも通るので、`gh api graphql`で直接叩く（issue-deck本体の
# `src/lib/github/sub-issues-api.ts`と同じクエリ）。
#
# **リポジトリ名も一緒に取る**（#1722）。サブIssueはリポジトリをまたげるため、`#123`とだけ書くと
# 受け取ったエージェントの側では自分のリポジトリの無関係なIssueに解決してしまう。担当Issueと
# 別のリポジトリのものだけ`owner/repo#123`と書く（画面から起動する経路
# `src/lib/prompts/build-implementation-prompt.ts`の`formatRelations`と同じ書式）。
prompt_context_relations() {
  local repo="$1" issue_number="$2" owner name json err_file err
  owner="${repo%%/*}"
  name="${repo##*/}"

  err_file="$(mktemp)"
  json="$(gh api graphql \
    -f query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      parent { number title state repository { nameWithOwner } }
      subIssues(first: 100) {
        totalCount
        nodes { number title state repository { nameWithOwner } }
      }
    }
  }
}' \
    -F owner="$owner" -F repo="$name" -F number="$issue_number" 2>"$err_file")" || json=""

  # **失敗と「親子が無い」を見分けられるようにする**（#1753）。黙って空にすると、今回のように
  # 壊れていることに誰も気づけない。
  if [[ -z "$json" ]]; then
    err="$(head -n 1 "$err_file" 2>/dev/null || true)"
    rm -f "$err_file"
    if [[ -n "$err" ]]; then
      printf '（取得できませんでした: %s）' "$err"
    else
      printf '（取得できませんでした）'
    fi
    return 0
  fi
  rm -f "$err_file"

  printf '%s' "$json" | REPO_FULL_NAME="$repo" python3 -c '
import json, os, sys

self_repo = os.environ.get("REPO_FULL_NAME", "")

try:
    d = json.load(sys.stdin)
except Exception:
    print("（取得できませんでした: 応答をJSONとして読めませんでした）")
    raise SystemExit(0)

issue = ((d.get("data") or {}).get("repository") or {}).get("issue")
if not isinstance(issue, dict):
    print("（取得できませんでした: Issueが見つかりませんでした）")
    raise SystemExit(0)


def ref(node):
    full_name = ((node.get("repository") or {}).get("nameWithOwner")) or self_repo
    number = node["number"]
    return f"{full_name}#{number}" if full_name and full_name != self_repo else f"#{number}"


def line(label, node):
    state = (node.get("state") or "").lower()
    title = node.get("title") or ""
    return f"- {label}: {ref(node)} {title}（{state}）"


lines = []
parent = issue.get("parent")
if isinstance(parent, dict) and parent.get("number"):
    lines.append(line("親", parent))

subs = issue.get("subIssues") or {}
nodes = subs.get("nodes") or []
for sub in nodes:
    if isinstance(sub, dict) and sub.get("number"):
        lines.append(line("子", sub))

total = subs.get("totalCount") or 0
if total > len(nodes):
    lines.append(f"- （子Issueは他に{total - len(nodes)}件あります）")

print("\n".join(lines) if lines else "(親子関係のあるIssueはありません)")
' 2>/dev/null || printf '（取得できませんでした: 整形に失敗しました）'
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
