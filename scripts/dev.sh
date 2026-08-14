#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# 待ち受けアドレスの既定を決めるために`tailscale serve`の状態を見る（#1329）。
# shellcheck source=scripts/lib/tailscale-serve.sh
source "$SCRIPT_DIR/lib/tailscale-serve.sh"

# next devは.env.localを自動読込するが、このスクリプト自身（bash）は読み込まないため明示的に読む。
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

PORT="${PORT:-3000}"

# 待ち受けアドレス（#1178）。**未指定なら原則 `-H` を渡さない。**
# `next dev` は既定で全インターフェース（IPv4/IPv6の両方）を待ち受けるため、Tailscale経由で
# 他端末（iPhone等）から画面を見るのはこの既定のままで成立する。`-H 0.0.0.0` を明示すると
# 逆にIPv4だけに絞られ、tailnetのIPv6アドレスからは見えなくなる。
# 127.0.0.1 に閉じたいときや、特定のインターフェースだけに出したいときに指定する。
DEV_HOST="${ISSUE_DECK_DEV_HOST:-}"
DEV_HOST_REASON="ISSUE_DECK_DEV_HOST"

# **例外は、このポートが`tailscale serve`で公開されているとき（#1329）。**
# serveは公開したポートを自ノードのtailnetアドレスで実際にlistenするため、`::`を要求する
# `next dev`とは両立せず、`listen EADDRINUSE :::<ポート>` で起動できない。順序に依存していて、
# 「devサーバー→serve」の順で始まったセッションでも、devサーバーだけが回収（#1223）された後は
# 二度と起こし直せなかった。ここで既定を倒しておけば、案内どおりの `pnpm dev` がそのまま通る。
#
# **serveは`localhost:<ポート>`へproxyするので、閉じてもtailnetのURLからは従来どおり見える。**
# `tailscale serve`が使えないホスト（メインPCのWSL等）では判定が常に偽になり、既定は変わらない。
if [ -z "$DEV_HOST" ] && tailscale_serve_published "$PORT"; then
  DEV_HOST="127.0.0.1"
  DEV_HOST_REASON="tailscale serve がポート ${PORT} を公開中のため。tailnetのURLからは引き続き見えます"
fi

HOST_ARGS=()
if [ -n "$DEV_HOST" ]; then
  HOST_ARGS=(-H "$DEV_HOST")
  echo "開発サーバーの待ち受けアドレスを ${DEV_HOST} に固定します（${DEV_HOST_REASON}）。" >&2
fi

# 同一LAN上の別端末（スマホ等）からsslip.io経由でアクセスできるよう、
# Windows側のポートフォワーディングをベストエフォートで設定する（失敗してもdevサーバー起動は続行する）。
#
# ワンクリック起動（scripts/start-local-session.sh）から始まったセッションでは
# ISSUE_DECK_SKIP_LAN_SETUP=1 が環境変数として届く。この経路（wt.exeで開いたタブ）では
# UACを承認しても待ちから戻らず、devサーバーが起動しないまま止まるため行わない（#1094）。
if [ "${ISSUE_DECK_SKIP_LAN_SETUP:-0}" != "0" ]; then
  echo "LANアクセス設定はスキップします（LAN内の別端末から見る場合は scripts/setup-lan-access.sh ${PORT} を実行してください）。" >&2
else
  bash "$(dirname "${BASH_SOURCE[0]}")/setup-lan-access.sh" "${PORT}" || echo "警告: LANアクセス設定に失敗しました。localhostでの確認は引き続き可能です。" >&2
fi

SMEE_PID=""
if [ -n "${GITHUB_WEBHOOK_PROXY_URL:-}" ]; then
  pnpm exec smee --url "${GITHUB_WEBHOOK_PROXY_URL}" --target "http://127.0.0.1:${PORT}/api/webhooks/github" &
  SMEE_PID=$!
  trap 'kill "${SMEE_PID}" 2>/dev/null || true' EXIT
else
  echo "GITHUB_WEBHOOK_PROXY_URL が未設定のため、smee client は起動しません。" >&2
fi

# set -u 下で空配列の展開がエラーにならないよう ${arr[@]+...} で囲む
next dev -p "${PORT}" ${HOST_ARGS[@]+"${HOST_ARGS[@]}"}
