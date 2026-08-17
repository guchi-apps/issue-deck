#!/usr/bin/env bash
# 計画の関門（G1・#1218）へ渡すプロンプトの組み立て。
#
# 誰が使うか:
#   scripts/start-reviewer.sh --plan   人が叩く入口（本体チェックアウトで対話セッションを起こす）
#   scripts/start-plan-review.sh       計画コメントの投稿を契機にpollerが起こす入口（#1855）
#
# **2つの入口で同じ文面を使うために切り出してある。** #1218の時点でプロンプトは
# 無人（`.github/prompts/plan-review.md`）とローカル（`scripts/prompts/plan-review-agent.md`）の
# 兄弟に分かれており、そこへローカルの自動入口が加わる。差し込み方まで各スクリプトに写すと、
# 置換するプレースホルダが1つずれただけで**片方の入口だけ`{{FLEET_STATUS}}`が生のまま渡る**
# （プロンプトとしては壊れていないので、指摘の質が落ちるまで誰も気付かない）。
#
# このファイル自体は実行せず、source して使う。

# 並行状況スナップショット（#1215）を取る。**取れなくても止めない**（俯瞰は材料の1つであって
# 必須ではない）。取れなければその旨の1行を返す。
#
#   $1 fleet-status.sh のパス / $2 突き合わせるgitリポジトリ / $3 owner/repo
plan_review_fleet_status() {
  local script="$1" root="$2" repository="$3" snapshot=""

  if [[ -x "$script" ]]; then
    # 直前に fetch 済み（人の入口は`git pull`、自動の入口は`question_refs_fetch_all`）なので
    # `--no-fetch`でよい。ここで待たされるぶんはそのままレビューの起動の遅れになる。
    snapshot="$("$script" --no-fetch --root "$root" --repo "$repository" 2>/dev/null || true)"
  fi

  if [[ -z "$snapshot" ]]; then
    printf '%s' "（並行状況のスナップショットは取得できませんでした）"
    return 0
  fi
  printf '%s' "$snapshot"
}

# プロンプトのプレースホルダを埋めて標準出力へ書く。
#
#   $1 テンプレートのパス / $2 Issue番号 / $3 owner/repo / $4 作業ディレクトリ
#   $5 作業ディレクトリの鮮度の説明 / $6 並行状況スナップショットを書いたファイル
#
# **値はファイル・引数で渡し、テンプレートの中身は解釈しない。** 計画本文もIssueの本文も
# ここには入らない（読むのはセッション自身の`gh issue view`）ので、埋めるのはこの5つだけ。
plan_review_render_prompt() {
  local template="$1" issue_number="$2" repository="$3" workdir="$4" checkout="$5" fleet_file="$6"

  python3 - "$template" "$issue_number" "$repository" "$workdir" "$checkout" "$fleet_file" <<'PY'
import sys

template_path, issue_number, repository, workdir, checkout, fleet_path = sys.argv[1:7]

with open(template_path, encoding="utf-8") as f:
    template = f.read()
with open(fleet_path, encoding="utf-8") as f:
    fleet = f.read().rstrip("\n")

replacements = {
    "{{ISSUE_NUMBER}}": issue_number,
    "{{REPOSITORY}}": repository,
    "{{WORKDIR}}": workdir,
    "{{CHECKOUT}}": checkout,
    "{{FLEET_STATUS}}": fleet,
}
result = template
for placeholder, value in replacements.items():
    result = result.replace(placeholder, value)
sys.stdout.write(result)
PY
}
