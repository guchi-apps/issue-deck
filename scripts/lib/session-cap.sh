#!/usr/bin/env bash
# 実装セッションの本数の上限を、空きメモリに応じて静的な上限より小さく絞る判定（#3780）。
#
# `DISPATCH_MAX_SESSIONS`は本数だけを見る固定の天井で、実際の空きメモリは見ない（#2095が
# メモリ・SWAPの逼迫で起動を止めるが、それは使用率が閾値を超えてから）。ここは天井の手前で、
# 「いまの空きで、あと何本足せるか」から実効上限を出す。
#
#   実効上限 = min(静的上限, 生きている本数 + (空き - 余白) ÷ 1本あたりの見積り)
#
# **`DISPATCH_SESSION_MEMORY_MB`が0（既定）のときは何もしない**（実効上限＝静的上限）。実施条件
# （SWAPの平常値の上昇・earlyoomの発火・上限待ちの頻発）がまだ起きていないため、有効にするかは
# サブPCの`dispatch.env`で選ぶ。
#
# **空きは`announce`が集めた`metrics`から出す**（`memoryTotalMb - memoryUsedMb`）。画面に出ている
# 使用率と同じ値で判定するための決めごとで、`/proc/meminfo`を別に読まない（launch-hold.shと同じ）。
# **`metrics`が取れなかった巡は絞らない**（余力が分からないことを止める理由にすると、`/proc`が
# 読めないだけで起動が永久に止まる）。
#
# 上乗せ分は0で下限を切るので、メモリが足りなくても実効上限は`live`を下回らない
# （既存のセッションは落とさず、新規の起動だけを止める）。

# 直前の判定の結果。**呼ぶたびに入れ直す**。
#
#   SESSION_CAP_EFFECTIVE  実効上限（0になりうる。claimの判定はこの値で行う）
#   SESSION_CAP_REPORTED   issue-deckへ申告する値（`maxSessions`は1以上しか受け付けないため、1未満にしない）
SESSION_CAP_EFFECTIVE=""
SESSION_CAP_REPORTED=""

# 使い方: resolve_session_cap <live> <静的な上限> <metricsのJSON> <1本あたりの見積りMB> <余白MB>
resolve_session_cap() {
  local live="$1" max="$2" metrics="$3" per_session_mb="$4" reserve_mb="$5" cap
  SESSION_CAP_EFFECTIVE="$max"
  SESSION_CAP_REPORTED="$max"
  [[ "$per_session_mb" -gt 0 ]] || return 0
  [[ -n "$metrics" ]] || return 0

  cap="$(printf '%s' "$metrics" | jq -r \
    --argjson live "$live" --argjson max "$max" \
    --argjson perSession "$per_session_mb" --argjson reserve "$reserve_mb" '
      if (.memoryTotalMb // 0) > 0 then
        ((.memoryTotalMb - .memoryUsedMb - $reserve) / $perSession | floor | if . < 0 then 0 else . end) as $headroom
        | [$max, $live + $headroom] | min
      else
        empty
      end' 2>/dev/null)" || return 0
  [[ -n "$cap" ]] || return 0

  SESSION_CAP_EFFECTIVE="$cap"
  SESSION_CAP_REPORTED="$cap"
  [[ "$cap" -ge 1 ]] || SESSION_CAP_REPORTED=1
  return 0
}
