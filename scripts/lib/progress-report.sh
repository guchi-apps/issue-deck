#!/usr/bin/env bash
# ローカルセッション起動時の進捗（Project Status）報告を、2つのランチャーで共有する（#1236）。
#
# `scripts/start-issue.sh`（issue-deck自身）と`scripts/generic-start-issue.sh`（汎用ランチャー・
# #1224）が同じ報告をする。**片方だけが直ると、どのリポジトリのIssueかで進捗の付き方が変わる。**
# 実際に#1224で汎用ランチャー側だけが`dispatch.env`へのフォールバックを持ち、issue-deck自身の
# Issueをサブpcで起動したときだけ`Ready`のまま動かない、という状態になっていた（#1236）。
#
# **複製先（`~/.local/share/issue-deck/`）へは配らない。** 受け口（start-local-session.sh）は
# このライブラリを使わず、ランチャーはどちらもissue-deckのチェックアウトから動く。
#
# ## 宛先と鍵をどこから読むか
#
# `APP_BASE_URL`（報告先）と`PROGRESS_REPORT_SECRET`（共有シークレット）を次の順で探し、
# 先に見つかった非空の値を使う。
#
#   1. 環境変数            pollerが`dispatch.env`を`set -a`で読んでいるため、ジョブ経由の起動では
#                          ここに入っている
#   2. 本体の`.env.local`  メインPC（アプリを動かすチェックアウト）はここに実値がある
#   3. `~/.config/issue-deck/dispatch.env`
#                          **サブPCのチェックアウトはアプリを動かすためのものではないため、
#                          `.env.local`のキーが空のことがある。** サブPC側の設定はここに集約する
#                          （置き場所は`ISSUE_DECK_DISPATCH_ENV`で変えられる）
#
# どこにも無ければ報告せず案内だけ出す。ローカルに鍵を持たない使い方（issue-deckの画面や
# カンバンから進捗を動かす）も成立するため、起動を止める理由にしない。

# envファイルから1つのキーの値を読む（存在しなければ空文字）。値はログに出さない。
read_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n1 | sed -e 's/^"//' -e 's/"$//'
}

# 報告先と鍵を解決し、PROGRESS_BASE_URL / PROGRESS_SECRET に入れる。
#   $1 issue-deckのチェックアウトのルート（`.env.local`を探す場所）
progress_resolve_endpoint() {
  local root="$1"
  local dispatch_env="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
  PROGRESS_BASE_URL="${APP_BASE_URL:-}"
  PROGRESS_SECRET="${PROGRESS_REPORT_SECRET:-}"
  [[ -n "$PROGRESS_BASE_URL" ]] || PROGRESS_BASE_URL="$(read_env_value "$root/.env.local" APP_BASE_URL)"
  [[ -n "$PROGRESS_SECRET" ]] || PROGRESS_SECRET="$(read_env_value "$root/.env.local" PROGRESS_REPORT_SECRET)"
  [[ -n "$PROGRESS_BASE_URL" ]] || PROGRESS_BASE_URL="$(read_env_value "$dispatch_env" APP_BASE_URL)"
  [[ -n "$PROGRESS_SECRET" ]] || PROGRESS_SECRET="$(read_env_value "$dispatch_env" PROGRESS_REPORT_SECRET)"
  PROGRESS_BASE_URL="${PROGRESS_BASE_URL%/}"
}

# 鍵が見つかるかどうかだけを確かめる（0=報告できる）。値は出力しない。
# 起動のたびではなく、pollerの起動時に設定漏れを1度だけ知らせる用途（#1236）。
progress_endpoint_available() {
  local root="$1"
  progress_resolve_endpoint "$root"
  [[ -n "$PROGRESS_BASE_URL" && -n "$PROGRESS_SECRET" ]]
}

# 起動時にIssueの進捗（Project Status）を報告する（#1096。#1010でラベル付与から置き換え）。
#
# `21.plan-required` が付いていれば `planning`、無ければ `implementation` を報告する。
#
# **既に進捗が始まっている場合は触らない。** 再開（#1076）で2回目以降に起動したときに、
# `Develop PR`まで進んだIssueを`Implementation`へ巻き戻さないため。判定にはissue-deckの
# 進捗問い合わせAPI（`GET /api/progress`）を使う。
#
# **報告に失敗しても起動は止めない**（起動できないより、記録が遅れる方が軽い）。
#
#   $1 issue-deckのチェックアウトのルート
#   $2 対象リポジトリ（`owner/repo`）
#   $3 Issue番号
#   $4 Issueに付いているラベル名（1行1つ）
report_start_progress() {
  local root="$1" full_name="$2" number="$3" labels="$4"
  local current desired code

  progress_resolve_endpoint "$root"
  if [[ -z "$PROGRESS_BASE_URL" || -z "$PROGRESS_SECRET" ]]; then
    echo "#$number: 進捗（Project Status）は報告しませんでした（APP_BASE_URL / PROGRESS_REPORT_SECRET が見つかりません）。"
    echo "     サブPCでは ~/.config/issue-deck/dispatch.env に両方を置いてください（deploy/subpc/dispatch.env.example 参照）。"
    echo "     issue-deckの画面の「実装を開始」ボタン、またはカンバンでカードを動かしても進められます。"
    return 0
  fi

  current="$(curl -sS -m 20 -H "Authorization: Bearer $PROGRESS_SECRET" \
    "$PROGRESS_BASE_URL/api/progress?repository=$full_name&issue=$number" 2>/dev/null |
    jq -r 'select(.available == true) | .status // empty' 2>/dev/null || true)"
  if [[ -n "$current" && "$current" != "ready" ]]; then
    echo "#$number: 進捗は既に開始済みです（$current）。巻き戻さないため報告しません。"
    return 0
  fi

  if printf '%s\n' "$labels" | grep -Fxq "21.plan-required"; then
    desired="planning"
  else
    desired="implementation"
  fi

  code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' \
    -X POST "$PROGRESS_BASE_URL/api/progress" \
    -H "Authorization: Bearer $PROGRESS_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"repository\":\"$full_name\",\"issue\":$number,\"status\":\"$desired\"}" 2>/dev/null)" || code=000
  if [[ "$code" == "200" ]]; then
    echo "#$number: 進捗を $desired として報告しました。"
  else
    echo "#$number: 警告: 進捗（$desired）の報告に失敗しました（HTTP $code）。issue-deckの画面から進めてください。" >&2
  fi
}
