#!/usr/bin/env bash
# メモリ・SWAPが逼迫している間、新しいセッションの起動を見送る判定（#2095）。
#
# ## 何が起きていたか
#
# pollerが起動を止めているのは`DISPATCH_MAX_SESSIONS`（本数）と`AppSetting.dispatchConcurrency`
# （払い出し）だけで、**実際の空きメモリは見ていなかった**。そのため12本に届いていなくても、
# 重い作業（テスト・ビルド）が重なっているところへさらにセッションを足してしまう。
# 2026-08-14にはサブPCがメモリ枯渇で停止し、SSHもコンソールも応答せずMagic SysRqでの
# 再起動が要った。#2076で重いコマンドの同時本数は絞ったが、あちらは走り出した後の話で、
# こちらは「入口で実際の余力を見る」という別の対処。片方だけでは残る。
#
# ## どう判定するか
#
# **1巡の入口で集めた`metrics`（`collect_host_metrics`）だけを見る。** 画面へ出している使用率と
# 同じ値なので、「画面は80%なのに90%で止まっている」という説明の付かない状態ができない。
#
# **メモリを先に見る。** どちらも閾値を超えていれば理由はメモリになる。SWAPが増えるのは
# メモリが足りなくなった結果なので、原因の側を出した方が読み手の次の行動（何を畳むか）に繋がる。
#
# **SWAPを持たないホスト（総量0）ではSWAPを見ない。** 割合を出せず、0%として扱うと
# 「常に空いている」と読める（issue-deck側の`describeSwapRow`と同じ向き）。
#
# **取れなかった巡は見送らない。** 余力が分からないことを止める理由にすると、`/proc`が
# 読めないだけで起動が永久に止まる。**この判定が壊れたときに倒れる向きを「起動する」側に
# 置いてある**（止まったままより、上限の本数まで起動する方が復旧できる）。
#
# 見送っている間も、停止・追加指示といった制御ジョブは従来どおり取りに行く（呼び出し側が
# `maxJobs: 0`でclaimする。`live_sessions >= MAX_SESSIONS`と同じ形）。

# 直前の判定の結果。**呼ぶたびに入れ直す**（見送っていなければ両方とも空）。
#
#   LAUNCH_HOLD_JSON     issue-deckへ申告する内容（`{reason, percent, thresholdPercent}`）
#   LAUNCH_HOLD_MESSAGE  journaldへ出す1行
LAUNCH_HOLD_JSON=""
LAUNCH_HOLD_MESSAGE=""

# 使い方: resolve_launch_hold <metricsのJSON> <メモリの閾値%> <SWAPの閾値%>
#
# 閾値はどちらも0〜100の整数で、**0はその項目で見送らない**（無効）。
# 判定できない入力（空・壊れたJSON）では見送らずに正常終了する。
resolve_launch_hold() {
  local metrics="$1" memory_threshold="$2" swap_threshold="$3" hold
  LAUNCH_HOLD_JSON=""
  LAUNCH_HOLD_MESSAGE=""
  [[ -n "$metrics" ]] || return 0

  hold="$(printf '%s' "$metrics" | jq -c \
    --argjson memoryThreshold "$memory_threshold" \
    --argjson swapThreshold "$swap_threshold" '
      (if (.memoryTotalMb // 0) > 0 then .memoryUsedMb / .memoryTotalMb * 100 else null end) as $memory |
      (if (.swapTotalMb // 0) > 0 then .swapUsedMb / .swapTotalMb * 100 else null end) as $swap |
      if $memoryThreshold > 0 and $memory != null and $memory >= $memoryThreshold then
        {reason: "MEMORY", percent: $memory, thresholdPercent: $memoryThreshold}
      elif $swapThreshold > 0 and $swap != null and $swap >= $swapThreshold then
        {reason: "SWAP", percent: $swap, thresholdPercent: $swapThreshold}
      else
        empty
      end' 2>/dev/null)" || return 0
  [[ -n "$hold" ]] || return 0

  LAUNCH_HOLD_JSON="$hold"
  LAUNCH_HOLD_MESSAGE="$(printf '%s' "$hold" | jq -r '
    (if .reason == "MEMORY" then "メモリ" else "SWAP" end) as $label |
    "\($label)が逼迫しているため、起動ジョブは取りに行きません（\($label) \(.percent | round)%・上限 \(.thresholdPercent)%）。"' \
    2>/dev/null)" || LAUNCH_HOLD_MESSAGE=""
  # 文言を組み立てられなくても見送りそのものは成立させる（呼び出し側は`LAUNCH_HOLD_JSON`を見る）
  [[ -n "$LAUNCH_HOLD_MESSAGE" ]] ||
    LAUNCH_HOLD_MESSAGE="メモリ・SWAPが逼迫しているため、起動ジョブは取りに行きません。"
  return 0
}
