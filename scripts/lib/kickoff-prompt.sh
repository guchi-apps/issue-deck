#!/usr/bin/env bash
# セッションへ最初に渡す1通（キックオフ文面）へ差し込む項目を作る（#1559）。
#
# 渡す本体は従来どおり「プロンプトファイルを読んで着手せよ」の1文で、ここで足すのは
# **Claude Codeの画面を見たときに分かるようにするための事実**（概要・選択されたオプション・
# 開発環境）だけ。エージェントへの指示は増やさない。
#
# `scripts/lib/prompt-context.sh` と同じ方針で、**判断はしない。事実だけを集める。**
# **どの関数も失敗しても起動を止めない。** 取れなければ空を返し、呼び出し側がその行を落とす。
#
# **本文は全文を載せない**（#1405）。`ps` の出力にIssue本文が丸ごと出るのを避けるという理由は
# 今も有効なので、概要は先頭 KICKOFF_PROMPT_SUMMARY_MAX_CHARS 文字までの抜粋に限る。全文は
# プロンプトファイルを読めば分かる。

# 概要として載せる最大文字数。これを超えたぶんは切り捨てて末尾に「…」を付ける。
KICKOFF_PROMPT_SUMMARY_MAX_CHARS=150

# 「実装を開始」ダイアログのオプション（#1317・#1473）に対応するラベルと、その日本語名。
#
# **文言と並び順は `src/lib/github/start-implementation.ts` の `START_IMPLEMENTATION_OPTIONS`
# と揃える。** 画面で選んだ名前がそのまま起動したセッションの画面にも出るようにするため。
# 二重に持つことになるので、ずれは `src/lib/prompts/kickoff-prompt.test.ts` が検出する。
KICKOFF_PROMPT_OPTION_LABELS=(
  "21.plan-required=計画が必要"
  "25.artifact-required=アーティファクトで見た目を出す"
  "22.merge-confirm-required=マージ前に確認が必要"
  "23.preview-required=開発環境を起動する"
  "24.screenshot-required=スクリーンショットが必要"
)

# プロンプトファイルの `- <キー>: <値>` 行を1つ読む。無ければ空を返す。
#
# `- タイトル: `・`- ラベル: `の行はissue-deck用（scripts/prompts/implementation-agent.md）と
# 汎用（scripts/prompts/generic-implementation-agent.md）の両テンプレートで共通なので、
# どちらのランチャー経由でも同じ処理で取れる。横断質問セッションのテンプレートには
# `- ラベル: `が無いため、そこでは空が返る。
kickoff_prompt_field() {
  local prompt_file="$1" key="$2"
  [[ -f "$prompt_file" ]] || return 0
  sed -n "s/^- ${key}: *//p" "$prompt_file" | head -n 1
}

# プロンプトファイルの `### 本文` から概要を作る。取れなければ空を返す。
#
# 記法（画像・リンク・見出し・箇条書きの記号・コードブロック・HTMLコメント）を落として1行へ畳み、
# 先頭 KICKOFF_PROMPT_SUMMARY_MAX_CHARS 文字までに切り詰める。**画像記法は落とすだけで、
# 画像そのものは元からこの文面に含まれない**（プロンプトファイル側の但し書きと同じ）。
kickoff_prompt_summary() {
  local prompt_file="$1"
  local limit="${2:-$KICKOFF_PROMPT_SUMMARY_MAX_CHARS}"
  [[ -f "$prompt_file" ]] || return 0

  python3 - "$prompt_file" "$limit" <<'PY' 2>/dev/null || true
import re
import sys

path, limit = sys.argv[1], int(sys.argv[2])

try:
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
except OSError:
    raise SystemExit(0)

BODY_HEADING = "### 本文"
# 本文の次に来るテンプレート側の見出し（scripts/prompts/*.md）。ここで確実に止める。
# **Issueの本文にも`###`の見出しは書ける**ので、`###`なら何でも止めるとは決められない。
STOP_HEADINGS = (
    "### 関連するIssue",
    "### 既存コメント",
    "### コメント",
    "### 本文・コメントに画像が貼られている場合",
)

collected = []
inside = False
in_fence = False
for line in lines:
    stripped = line.strip()
    if not inside:
        if stripped == BODY_HEADING:
            inside = True
        continue

    # テンプレート側の見出しなら必ず終わる。それ以外の`###`は、**まだ1文字も拾えていない間は
    # 終わらせない**（本文自体が見出しで始まるIssueで、中身を1つも拾えないまま抜けるのを避ける）。
    # 範囲が広すぎても先頭 limit 文字しか使わないので実害が無く、狭すぎる側だけが空振りになる。
    if stripped in STOP_HEADINGS:
        break
    if collected and stripped.startswith("###"):
        break

    if stripped.startswith("```"):
        in_fence = not in_fence
        continue
    if in_fence:
        continue

    text = stripped
    text = re.sub(r"<!--.*?-->", "", text)
    # 画像は落とす。リンクは表示テキストだけ残す（URLは概要として読む価値が無い）
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    # 箇条書き・引用・見出しの記号と、強調の記号を落とす
    text = re.sub(r"^\s*(?:[-*+]\s+|\d+\.\s+|>\s*|#{1,6}\s+)", "", text)
    text = text.replace("**", "").replace("`", "")
    text = re.sub(r"\s+", " ", text).strip()

    if not text or text == "(本文なし)":
        continue
    collected.append(text)

summary = " ".join(collected)
if len(summary) > limit:
    summary = summary[:limit] + "…"
if summary:
    print(summary)
PY
}

# `- ラベル: ` の値から、選択されたオプションの日本語名を「 / 」で連ねて返す。
# オプションのラベルが1つも付いていなければ空を返す（呼び出し側がその行ごと落とす）。
kickoff_prompt_options() {
  local labels="$1"
  [[ -n "$labels" ]] || return 0

  local entry name display result=""
  for entry in "${KICKOFF_PROMPT_OPTION_LABELS[@]}"; do
    name="${entry%%=*}"
    display="${entry#*=}"
    # 「, 」区切りの一覧に完全一致で含まれるかを見る。前後にカンマを足して部分一致を防ぐ
    if [[ ",${labels// /}," == *",${name},"* ]]; then
      [[ -z "$result" ]] || result+=" / "
      result+="$display"
    fi
  done
  printf '%s' "$result"
}

# 開発環境の案内を返す。ポートが無い（横断質問セッション等）場合は空を返す。
#
# 第3引数は開発サーバーを起動したか（1で起動済み）。第2引数のtailnetのURL（#1265）は
# あれば添える。**スマホから画面を見る唯一の出口**なので、画面の文面にも載せておく。
kickoff_prompt_dev_environment() {
  local port="$1" preview_url="${2:-}" started="${3:-0}"
  [[ -n "$port" && "$port" != "0" ]] || return 0

  local note
  if [[ "$started" == "1" ]]; then
    note="起動済み"
  else
    note="未起動・worktreeで pnpm dev を実行すると起動します"
  fi
  if [[ -n "$preview_url" ]]; then
    note+=" / tailnet: $preview_url"
  fi
  printf 'http://localhost:%s（%s）' "$port" "$note"
}

# キックオフ文面へ足す行をまとめて返す（取れた項目だけ・末尾の改行なし）。
# 何も取れなければ空を返し、呼び出し側は従来どおりの1文だけで起動する。
kickoff_prompt_context_block() {
  local prompt_file="$1" port="${2:-}" preview_url="${3:-}" started="${4:-0}"
  local summary options dev_environment block=""

  summary="$(kickoff_prompt_summary "$prompt_file")"
  options="$(kickoff_prompt_options "$(kickoff_prompt_field "$prompt_file" "ラベル")")"
  dev_environment="$(kickoff_prompt_dev_environment "$port" "$preview_url" "$started")"

  [[ -z "$summary" ]] || block+="- 概要: $summary"$'\n'
  [[ -z "$options" ]] || block+="- オプション: $options"$'\n'
  [[ -z "$dev_environment" ]] || block+="- 開発環境: $dev_environment"$'\n'

  # 末尾の改行を落として返す（呼び出し側が空かどうかで判定できるようにする）
  printf '%s' "${block%$'\n'}"
}
