#!/usr/bin/env bash
# 1リポジトリぶんの「共有スクリプトを最新版へ更新するPR」を作る（#2240）。
#
# propagate-shared-files.yml から1リポジトリずつ呼ばれる。配るのは
# `.github/scripts/signaly-notify.sh` のような**ワークフロー以外の配布物**で、
# **どれを配るかは呼び出し元（issue-deckの画面）が決めて渡す**（ここで再検知すると画面の
# 表示と実際の対象がずれる。propagate-repair-workflows.sh と同じ方針）。
#
# **caller配布（propagate-repair-workflows.sh）との違いは3つ。**
#   1. 配布元は `.github/templates/` の雛形ではなく**issue-deck自身の実物**。中身をそのまま
#      配るので雛形を置くと二重管理になり、実物を直したのに古い写しが配られる事故になる。
#      issue-deck自身が同じスクリプトを ci.yml・deploy.yml から使っているため、壊れれば
#      このリポジトリのCIで先に分かる。
#   2. 配るのは**既に置いてあるリポジトリだけ**。signaly-notify.sh を呼ぶのは ci.yml・
#      deploy.yml 側のステップなので、スクリプトだけ新規に置いても誰も呼ばない。
#   3. 判定が「有るか無いか」ではなく**中身が同じか**。同じならスキップする（毎回PRを作らない）。
#
# **配布先の独自の変更は消えうる。** 実際 guchi-apps/subpc のコピーには、そのリポジトリだけの
# NOTIFY_NOTE が入っている。**配布先のコピーにしか無い記述をPR本文へ書き出す**ので、確認して
# マージすること（自動マージはしない。caller配布と同じ）。
#
# **「しか無い記述」は行ではなく語で見る**（src/lib/workflow-tags.ts の
# hasLocalSharedFileContent と同じ判定）。行で比べると、配布元で書き換わっただけの行
# （run_url= ・curl -fsS \ など）が全リポジトリで引っかかり、本当に独自の変更がある subpc を
# 見分けられなかった（実測で16件中16件が該当）。
#
# **配布物のコピーに加えて、ワークフローへの1行追加も相乗りさせている**（#2391）。
# `deploy.yml`・`release.yml` のリリース通知ステップへ `SIGNALY_RELEASE_WEBHOOK_URL` を足す
# （詳細は下の該当箇所のコメント）。丸ごと配れないファイルへ**アンカー行の隣に1行足すだけ**の
# 編集をする例外で、ここを増やすときは「リポジトリごとの中身に依存しない」ことを確かめること。
#
# **このスクリプトは1リポジトリの失敗で全体を止めない前提で書かれている。** 呼び出し元が
# 戻り値を見て件数を数えるため、失敗時は非0で返すこと。
set -uo pipefail

REPO="$1"        # owner/repo
FILES="$2"       # 配るパス（空白区切り。例: ".github/scripts/signaly-notify.sh"）
SOURCE_REPO="$3" # 配布元（guchi-apps/issue-deck）

# 配布元はこのリポジトリ（issue-deck）のチェックアウトそのもの
SOURCE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# 配れるパスの許可リスト。**src/lib/workflow-tags.ts の SHARED_FILE_SPECS と同じ内容**にする
# （食い違うと、画面から配ろうとしたファイルがここで黙ってスキップされる）。
ALLOWED_FILES=".github/scripts/signaly-notify.sh"

fail() {
  echo "  $1" >&2
  exit 1
}

DEFAULT_BRANCH="$(gh api "repos/$REPO" --jq .default_branch 2>/dev/null)" \
  || fail "リポジトリ情報を取得できません"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --depth 1 --branch "$DEFAULT_BRANCH" "https://x-access-token:${GH_TOKEN}@github.com/$REPO.git" "$WORK/repo" \
  || fail "cloneに失敗しました"

cd "$WORK/repo" || fail "作業ディレクトリへ移動できません"

# 配布先のコピーにしか無い記述。**ファイルごとに見出しを付けてPR本文へ書き出す**
LOST="$WORK/lost.md"
: > "$LOST"

UPDATED=""
for FILE in $FILES; do
  ALLOWED=false
  for CANDIDATE in $ALLOWED_FILES; do
    [ "$FILE" = "$CANDIDATE" ] && { ALLOWED=true; break; }
  done
  if [ "$ALLOWED" != "true" ]; then
    echo "  $FILE は配布対象外です。スキップします"
    continue
  fi

  SOURCE="$SOURCE_DIR/$FILE"
  [ -f "$SOURCE" ] || fail "配布元に $FILE がありません"

  # **置かれていないリポジトリへは配らない。** 呼び出し側のステップごと入れるのは
  # 「そのリポジトリにCI・デプロイ通知を導入する」作業で、機械的な配布とは別物
  if [ ! -f "$FILE" ]; then
    echo "  $FILE は置かれていません。スキップします"
    continue
  fi

  if cmp -s "$SOURCE" "$FILE"; then
    echo "  $FILE は既に最新です。スキップします"
    continue
  fi

  # 消えるものを先に取る（上書き後には比べられない）。配布元に一度も出てこない語を含む行だけを
  # 挙げる（書き換わっただけの行を除くため。上のコメントを参照）
  LOST_LINES="$(awk '
    NR == FNR {
      tmp = $0
      while (match(tmp, /[A-Za-z_][A-Za-z0-9_]*/)) {
        known[substr(tmp, RSTART, RLENGTH)] = 1
        tmp = substr(tmp, RSTART + RLENGTH)
      }
      next
    }
    {
      tmp = $0
      keep = 0
      while (match(tmp, /[A-Za-z_][A-Za-z0-9_]*/)) {
        if (!(substr(tmp, RSTART, RLENGTH) in known)) keep = 1
        tmp = substr(tmp, RSTART + RLENGTH)
      }
      if (keep) print
    }
  ' "$SOURCE" "$FILE")"
  if [ -n "$LOST_LINES" ]; then
    {
      printf '<details><summary><code>%s</code>（%s行）</summary>\n\n```\n' \
        "$FILE" "$(printf '%s\n' "$LOST_LINES" | wc -l)"
      printf '%s\n' "$LOST_LINES"
      printf '```\n\n</details>\n\n'
    } >> "$LOST"
  fi

  # **実行ビットも配布元にそろえる。** gitが記録するmodeは100755/100644の別だけなので、
  # 中身を写したうえで配布元と同じパーミッションにする（呼び出し側は `bash <path>` と
  # 直接実行の両方があり、実行ビットが落ちていると後者だけが `Permission denied` になる）
  cat "$SOURCE" > "$FILE" || fail "$FILE の更新に失敗しました"
  chmod --reference="$SOURCE" "$FILE" || fail "$FILE のパーミッションを合わせられません"

  UPDATED="$UPDATED $FILE"
done

UPDATED="${UPDATED# }"

# ── リリース通知を専用チャンネルへ向けるenvを、配布先のワークフローへ足す（#2391）───────
#
# **スクリプトだけでは分離できない。** GitHub Actionsのsecretはワークフローが`env:`へ
# 渡さないとスクリプトから読めないため、配布先の`deploy.yml`・`release.yml`にも1行が要る。
# 配布の仕組みはどれも「丸ごとコピー」「固定の置換」「新規追加」しかできず、リポジトリごとに
# 中身が違う`deploy.yml`は丸ごと配れない。そこで**アンカー行の隣へ1行足すだけ**の編集を、
# 通知スクリプトの配布PRに相乗りさせる。
#
# アンカーは`NOTIFY_KIND:`の値が`リリース`の行（リリース通知のステップは全リポジトリで
# この行を持つ）。**既に入っていれば何もしない**ので、配布を何度実行しても増えない。
#
# **突き合わせは行の完全一致で行わない**（#2421）。`NOTIFY_KIND: リリース`という文字列との
# 一致で見ていたときは、次の2件が黙って外れ、**配布PRは作られるのにこの1行だけが入らない**
# 状態が続いた。画面の「配布が必要」判定は通知スクリプトの中身しか見ないため、外れても
# 表示には出ない。
#
#   - `guchi-apps/signaly` … 値を桁揃えしていて`NOTIFY_KIND:     リリース`（コロンの後が複数スペース）
#   - `guchi-apps/asset-manager` … 改行がCRLFで、行末に`\r`が残る
#
# そこでコロンの後の空白は幅を問わず、行末のCRは取り除いてから値を比べる。**足す行の行末も
# 元の行に合わせる**（CRLFのファイルへLFの行だけを混ぜない）。
RELEASE_ENV_LINE='SIGNALY_RELEASE_WEBHOOK_URL: ${{ secrets.SIGNALY_RELEASE_WEBHOOK_URL }}'
PATCHED=""
for WF in .github/workflows/deploy.yml .github/workflows/release.yml; do
  [ -f "$WF" ] || continue
  if grep -q 'SIGNALY_RELEASE_WEBHOOK_URL' "$WF"; then
    echo "  $WF には既にリリース用のwebhookが入っています。スキップします"
    continue
  fi

  awk -v insert="$RELEASE_ENV_LINE" '
    {
      trimmed = $0
      eol = ""
      if (trimmed ~ /\r$/) { eol = "\r"; sub(/\r$/, "", trimmed) }
      sub(/[ \t]+$/, "", trimmed)
      match(trimmed, /^[ \t]*/)
      indent = substr(trimmed, 1, RLENGTH)
      body = substr(trimmed, RLENGTH + 1)
      if (index(body, "NOTIFY_KIND:") == 1) {
        value = substr(body, length("NOTIFY_KIND:") + 1)
        sub(/^[ \t]+/, "", value)
        if (value == "リリース") printf "%s%s%s\n", indent, insert, eol
      }
      print $0
    }
  ' "$WF" > "$WF.tmp" || fail "$WF を書き換えられません"

  # **アンカーが無ければ何も変わらない。** 変わっていないファイルをPATCHEDへ入れると、
  # PR本文が足していない行を足したと書くことになる
  if cmp -s "$WF" "$WF.tmp"; then
    rm -f "$WF.tmp"
    continue
  fi

  mv "$WF.tmp" "$WF" || fail "$WF の更新に失敗しました"

  PATCHED="$PATCHED $WF"
done
PATCHED="${PATCHED# }"

if [ -n "$PATCHED" ]; then
  RELEASE_NOTE="$(printf 'リリース通知を専用チャンネルへ向ける`SIGNALY_RELEASE_WEBHOOK_URL`を足した: %s\n\n**organization secretが未登録のあいだも通知は消えない。** 空が渡ると、スクリプトが\nこれまでのCI・デプロイ用チャンネルへ送る。' "$PATCHED")"
else
  RELEASE_NOTE="リリース通知のワークフローに足すものはなかった（既に入っているか、このリポジトリはリリース通知を出していない）。"
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "  更新するファイルがありません。スキップします"
  exit 0
fi

if [ -s "$LOST" ]; then
  LOST_NOTE="$(printf '**このリポジトリのコピーにしか無い記述が消えます。** 残すべきものが含まれていないか確認してください。\n\n%s' "$(cat "$LOST")")"
else
  LOST_NOTE="このリポジトリのコピーにしか無い記述はありません（配布元に無い語を含む行が1つもありません）。"
fi

# ブランチ名は固定。`issue-*`ではないため、配布先の issue-labels.yml（push on issue-*）は動かない
BRANCH="shared-files"

git checkout --quiet -b "$BRANCH" || fail "ブランチを作成できません"
git add -A

COMMIT_MESSAGE="$(printf '共有スクリプトを最新版へ更新する\n\n各リポジトリの .github/scripts/ へコピーして使っているスクリプトを、配布元\n（%s）の内容へそろえる。コピー運用のため、配布元を直しても\n各リポジトリへは自動では行き渡らない。\n\n更新: %s\nワークフロー: %s\n' "$SOURCE_REPO" "${UPDATED:-（なし）}" "${PATCHED:-（なし）}")"
git commit --quiet -m "$COMMIT_MESSAGE" || fail "コミットに失敗しました"

# ブランチ名が固定のため、前回マージされずに閉じたPRの残骸が残っていることがある。
# **中身は毎回このスクリプトが作り直すもの**なので上書きしてよい（propagate-repair-workflows.sh と
# 同じ理由・同じ手順。単一ブランチcloneでは素の --force-with-lease が使えない）。
if ! git push --quiet -u origin "$BRANCH"; then
  git fetch --quiet --depth 1 origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" \
    || fail "pushに失敗しました（残っているブランチも取得できません）"

  REMOTE_SHA="$(git rev-parse "refs/remotes/origin/$BRANCH")" || fail "pushに失敗しました"
  git push --quiet --force-with-lease="$BRANCH:$REMOTE_SHA" -u origin "$BRANCH" \
    || fail "pushに失敗しました"
fi

PR_BODY="$(printf '## 実装内容\n\n各リポジトリの `.github/scripts/` へコピーして使っているスクリプトを、配布元（%s）の\n内容へそろえた。**コピー運用のため、配布元を直しても各リポジトリへは自動では行き渡らない。**\n\n更新: %s\n\n`signaly-notify.sh` を含む場合、今回そろえる主な変更は\n**「リリース通知をCI・デプロイと別のチャンネルへ分け、本文に変更内容を載せる」**\n（%s#2391）。あわせて、通知が届かなくても `exit 0` で返す（#2237・#2239）。\n\n## リリース通知のチャンネル分離\n\n%s\n\n## 上書きで消える記述\n\n%s\n\n## 確認方法\n\n- このPRのCIが成功すること\n- マージ後、次のデプロイ・CIでSignalyへ通知が届くこと（届かない場合も run が緑のままで、\n  ログに `::warning::Signalyへの通知に失敗しました` が出ること）\n- 次のリリースの通知が「リリース」チャンネルへ届き、本文に変更内容が出ること\n\n## 注意点\n\n- **呼び出し側のステップには `continue-on-error: true` を付けておく。** スクリプトは常に0で\n  返すが、付けておくと将来スクリプト自体が落ちたときもrunを赤くしない\n- **自動マージしない。** 配布先の独自の変更を上書きしうるため、内容を確認して手でマージする\n\n---\n\n%s の画面から一括作成されたPRです（対応Issueは作成していない）。\n' \
  "$SOURCE_REPO" "${UPDATED:-（なし）}" "$SOURCE_REPO" "$RELEASE_NOTE" "$LOST_NOTE" "$SOURCE_REPO")"

PR_URL="$(gh pr create --repo "$REPO" --base "$DEFAULT_BRANCH" --head "$BRANCH" \
  --title "共有スクリプトを最新版へ更新する" \
  --body "$PR_BODY" 2>/dev/null)" \
  || fail "PRの作成に失敗しました"

echo "  作成しました: $PR_URL"
