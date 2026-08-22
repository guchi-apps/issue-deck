#!/usr/bin/env bash
# 重いコマンド（テスト・ビルド）を、**機体全体で同時N本まで**に絞って実行する（#2076）。
#
# 使い方（`package.json`のscriptsから通す。手で叩くこともできる）:
#   bash scripts/heavy-command.sh vitest run
#   bash scripts/heavy-command.sh next build
#
# 環境変数:
#   HEAVY_COMMAND_SLOTS             同時に走ってよい本数（既定2・**0でこの仕組みを無効**にする）
#   HEAVY_COMMAND_TIMEOUT_SECONDS   枠が空くのを待つ上限（既定900＝15分・0で無制限に待つ）
#   HEAVY_COMMAND_LOCK_DIR          枠の置き場（既定 ${XDG_CACHE_HOME:-~/.cache}/heavy-command）
#
# ## なぜ要るか
#
# サブPCでは実装セッションが最大12本（`DISPATCH_MAX_SESSIONS`）同時に生きている。既存の上限は
# **ジョブの払い出し**（`AppSetting.dispatchConcurrency`＝3）と**セッションの本数**にしか効かず、
# **立った後のセッションが何を走らせるかには何の制限も無い**。つまり12本が同時に
# `pnpm test:unit`・`pnpm build`を始められる。
#
# 2026-08-22の実測（サブPC・12スレッド／13.9GiB／SWAP 4GiB）:
#
#   - `pnpm test:unit` 1本 … ワーカー11個・ピーク3.24GiB・所要70秒
#   - `next build` 1本    … 約2.8GiB（#1812の実測表から。2本同時で5.55GiB）
#   - セッション本体      … `claude`1本あたり約0.5GiB（12本で約6.1GiB）
#
# セッション本体だけで6GiBを使っているところへ重いコマンドが2本重なるとSWAPへ落ち、実際に
# `earlyoom`が開発サーバー（`next-server`）をkillしている（2026-08-16以降7回）。
# **CPUではなくメモリが先に尽きる**のは#1812の実測と同じ。
#
# ## 作法
#
# **これは計器であって役ではない**（docs/multi-agent/gates.md「計器」）。判断はせず、枠が空くまで
# 待って渡されたコマンドをそのまま実行するだけで、LLMも人への問い合わせも挟まない。
#
# **待たせきりにしない。** 待ちが上限（既定15分）を超えたら警告を出して**そのまま実行する**。
# ここで止めると、作業そのものが進まなくなる。絞るのは山を削るためであって、止めるためではない。
#
# **入れ子では待たない。** `pnpm test`（lint && typecheck && test:unit）のように、この仕組みを
# 通したコマンドの中からさらに通る経路があるため、枠を持ったまま自分の枠を待って固まるのを防ぐ。
#
# **`flock`が無い環境ではそのまま実行する**（scripts/lib/question-refs.sh と同じ倒し方）。
# 絞れないことより、絞る仕組みが無い環境で動かなくなることのほうが困る。
#
# **`pnpm dev`は通さない。** 開発サーバーは動かし続けるものなので、枠を握ったまま返さない。
# あちらの本数は scripts/reap-dev-servers.sh のアイドル回収が抑える。

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: bash scripts/heavy-command.sh <コマンド> [引数...]" >&2
  exit 1
fi

SLOTS="${HEAVY_COMMAND_SLOTS:-2}"
TIMEOUT_SECONDS="${HEAVY_COMMAND_TIMEOUT_SECONDS:-900}"
LOCK_DIR="${HEAVY_COMMAND_LOCK_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/heavy-command}"

# 設定は外から来るので、数値であることを確かめてから使う。壊れた値で枠が0本になり、
# 何も実行できなくなる（あるいは無制限になる）のを防ぐ。
if [[ ! "$SLOTS" =~ ^[0-9]+$ ]]; then
  echo "警告: HEAVY_COMMAND_SLOTS は0以上の整数で指定してください（$SLOTS）。既定の2で続けます。" >&2
  SLOTS=2
fi
if [[ ! "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "警告: HEAVY_COMMAND_TIMEOUT_SECONDS は0以上の整数で指定してください（$TIMEOUT_SECONDS）。既定の900で続けます。" >&2
  TIMEOUT_SECONDS=900
fi

# 枠を取らずにそのまま実行する。**戻り値はコマンドのものをそのまま返す。**
run_directly() {
  "$@"
}

# 無効化・入れ子・`flock`の無い環境は、いずれもそのまま実行する側へ倒す。
if [[ "$SLOTS" -eq 0 ]]; then
  run_directly "$@"
  exit $?
fi
if [[ -n "${HEAVY_COMMAND_HELD:-}" ]]; then
  run_directly "$@"
  exit $?
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "情報: flock が無いため、同時実行の制限なしで実行します。" >&2
  run_directly "$@"
  exit $?
fi
if ! mkdir -p "$LOCK_DIR" 2>/dev/null; then
  echo "情報: $LOCK_DIR を作成できないため、同時実行の制限なしで実行します。" >&2
  run_directly "$@"
  exit $?
fi

# 空いている枠をひとつ掴む。掴めたら0を返し、掴んだfdを $ACQUIRED_FD に入れる。
#
# **`flock -n`で1本ずつ試す**（`flock -w`で1本目を待たない）。待ちに入ると、その1本が空くまで
# 他の枠が空いていても取りに行けない。
#
# **`exec`のリダイレクトに`2>/dev/null`を直接付けない。** `exec`のリダイレクトはシェル自身に
# 恒久的に効くため、`exec {fd}>file 2>/dev/null`と書くと**そこから先の標準エラー出力が
# 丸ごと捨てられる**（待機中のメッセージが出なくなる）。囲って、その中だけに効かせる。
ACQUIRED_FD=""
try_acquire() {
  local index fd file
  for ((index = 1; index <= SLOTS; index++)); do
    file="$LOCK_DIR/slot-$index.lock"
    # 開けないファイルを`exec`に渡すとシェルごと終わるため、先に作れることを確かめる
    : >>"$file" 2>/dev/null || continue
    { exec {fd}>"$file"; } 2>/dev/null || continue
    if flock -n "$fd" 2>/dev/null; then
      ACQUIRED_FD="$fd"
      return 0
    fi
    exec {fd}>&-
  done
  return 1
}

WAITED=0
WAIT_STEP=3
# 待っていることが分かるよう定期的に出す。**出さないと固まったように見える**（エージェントが
# 待ちを異常とみなして中断するのを防ぐ）。
NOTICE_INTERVAL=30

while ! try_acquire; do
  if [[ "$WAITED" -eq 0 ]]; then
    echo "情報: 他のセッションが重いコマンドを実行中のため待機します（枠 ${SLOTS} 本）。" >&2
  elif [[ $((WAITED % NOTICE_INTERVAL)) -eq 0 ]]; then
    echo "情報: 待機中です（${WAITED}秒経過・枠 ${SLOTS} 本）。" >&2
  fi

  if [[ "$TIMEOUT_SECONDS" -gt 0 && "$WAITED" -ge "$TIMEOUT_SECONDS" ]]; then
    echo "警告: ${TIMEOUT_SECONDS}秒待っても枠が空かないため、制限なしで実行します。" >&2
    break
  fi

  sleep "$WAIT_STEP"
  WAITED=$((WAITED + WAIT_STEP))
done

if [[ -n "$ACQUIRED_FD" && "$WAITED" -gt 0 ]]; then
  echo "情報: 枠が空いたので実行します（${WAITED}秒待機）。" >&2
fi

# 掴んだfdはこのシェルが持ったままにする（コマンドの終了とともに閉じられ、枠が返る）。
# `exec`で置き換えないのは、置き換えるとfdの扱いがシェルの実装依存になるため。
export HEAVY_COMMAND_HELD=1
set +e
"$@"
RC=$?
set -e

if [[ -n "$ACQUIRED_FD" ]]; then
  exec {ACQUIRED_FD}>&-
fi
exit "$RC"
