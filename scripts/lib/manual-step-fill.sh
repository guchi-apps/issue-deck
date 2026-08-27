#!/usr/bin/env bash
# 手作業の`<…>`へ、人が埋めた値を差し込む（#2403）。
#
# ## なぜpoller側で差し込むのか
#
# 代行実行の歯止めは「実行するのはIssue本文に書かれたコマンドだけで、画面から届いた文字列は
# 照合にしか使わない」（`enqueueManualStepJob`のコメント）。値を埋めたコマンドを画面から
# 受け取って実行すると、この歯止めが丸ごと消える。
#
# そこで**受け取るのは値だけ**にし、コマンドの形は今までどおり本文から取る。本文との照合
# （サーバーとpollerが独立に2回）を通したあとで、`<…>`の穴にだけ値を単引用符で包んで
# 差し込む。単引用符の中はシェルが一切解釈しないので、**値は常にリテラルの1語**にしかならず、
# コマンドの構造を変えられない。
#
# ## issue-deck側にも同じ規則がある
#
# `src/lib/manual-step-command.ts`の`shellQuoteValue`・`fillManualStepPlaceholders`が同じ形を
# 持ち、サーバーはその結果を`resolvedCommand`として渡してくる。**重複ではなく2枚目の壁**で、
# pollerは自分で差し込んだ結果と突き合わせ、一致しなければ実行しない（本文照合を2回行うのと
# 同じ形）。ずれた場合の結果が「誤ったコマンドの実行」ではなく「実行しない」になる。

# 単引用符で包んで、シェルにとってリテラルの1語にする（#2403）。
#
# 単引用符の中はシェルが一切解釈しない（`$`・`;`・`&&`・改行を含めて）。値に`'`が入っている
# ときだけ`'\''`で継ぎ足す。**これが、画面から届いた値がコマンドの構造を変えられないことの
# 唯一の担保**で、issue-deck側（`src/lib/manual-step-command.ts`の`shellQuoteValue`）と
# 同じ規則を独立に持つ。**重複ではなく2枚目の壁**で、ずれた場合は下の突き合わせで実行しない。
shell_quote_value() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

# 本文照合を通したテンプレートの`<…>`へ、人が埋めた値を引用付きで差し込む（#2403）。
#
# 置き換えるのは**名前の付く山括弧だけ**で、値が届いていない穴はそのまま残す（残れば
# issue-deck側が積む前に弾いているはずだが、こちらでも実行前に確かめる）。
# 行頭が`#`の行は実行されないコメントなので触らない（issue-deck側と同じ）。
fill_placeholders() {
  local template="$1" values_json="$2"
  local token value line out=""
  while IFS= read -r line; do
    if [[ "${line#"${line%%[![:space:]]*}"}" == \#* ]]; then
      out+="$line"$'\n'
      continue
    fi
    while IFS= read -r token; do
      [[ -n "$token" ]] || continue
      value="$(printf '%s' "$values_json" | jq -r --arg k "$token" '.[$k] // empty')"
      [[ -n "$value" ]] || continue
      line="${line//"$token"/"$(shell_quote_value "$value")"}"
    done < <(printf '%s' "$values_json" | jq -r 'keys_unsorted[]')
    out+="$line"$'\n'
  done <<<"$template"
  printf '%s' "${out%$'\n'}"
}

