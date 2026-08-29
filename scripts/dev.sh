#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# tailnetへの公開（#1265）を起こし直しでも張り直すため（#1363）。
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

# ログインに要る値が揃っているかを起動時に見せる（#1419）。
# 揃っていないとログインボタンを押した先が存在しないURL（`https://ci-placeholder.supabase.co/...`）
# になり画面が真っ白になるが、**ブラウザ側には何も出ないため原因に辿り着けなかった。**
# ログイン画面にも同じ判定を出しているが（`src/lib/supabase/config.ts`）、
# `.dev-servers/issue-<番号>.log`に残ると画面を開く前に気づける。**起動は止めない**
# （ログインが要らない画面の確認はこのままでもできる）。
CI_PLACEHOLDER_MARKER="ci-placeholder"
missing_auth_env=()
for key in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ALLOWED_EMAILS; do
  value="${!key:-}"
  if [ -z "$value" ] || [[ "$value" == *"$CI_PLACEHOLDER_MARKER"* ]]; then
    missing_auth_env+=("$key")
  fi
done
if [ "${#missing_auth_env[@]}" -gt 0 ]; then
  echo "警告: ログインに必要な環境変数が未設定です（${missing_auth_env[*]}）。この状態ではログインできません（#1419）。.env.local を確認してください。" >&2
fi

# ログインできても、開発DBは既定で空なので画面には何も出ない（#1473）。ダミーデータの
# 用意がまだなら、その入口をここで案内する。**起動は止めない**（案内だけ）。
if [ -z "${CI_LOGIN_BYPASS_SECRET:-}" ]; then
  echo '案内: 開発DBが空だと画面には何も表示されません。`pnpm db:seed:dev` でダミーデータと開発用ログインを用意できます（#1473）。' >&2
fi

# 待ち受けアドレス（#1178・#1329・#1526）。**未指定なら常に `127.0.0.1` に閉じる。**
#
# `next dev` の既定は全インターフェース（`::`）で、tailnetにも同一LANにもそのまま出る。#1178では
# それを「Tailscale経由でスマホから画面を見るための既定」として受け入れ、閉じるほうを例外
# （`ISSUE_DECK_DEV_HOST`の明示指定か、そのポートが`tailscale serve`で公開中のとき・#1329）に
# していた。**しかし閉じる側が条件付きだったため、条件を満たさない起動が意図せず外へ出ていた**
# （#1526。issue-1309のdevサーバーだけが`*:5309`で待ち受け、tailnet上の他端末から到達できた）。
# worktreeは分岐した時点のこのスクリプトを持ち続けるので、条件を後から足しても遡っては効かない。
#
# そこで**既定と例外の向きを反転させる**。未指定なら閉じ、開けたいときだけ明示する。
#
# - tailnetへ出す経路は`tailscale serve`（`localhost:<ポート>`へproxy）に一本化してある。
#   **閉じてもtailnetのURLからは引き続き見える**（scripts/lib/tailscale-serve.sh・#1265）。
# - #1329が避けていた`EADDRINUSE`（serveが残っているポートで`::`を要求して落ちる）も、
#   より広いこの既定に吸収されるので、serveの公開状態を見る分岐は持たない。
# - 開けたいときは`ISSUE_DECK_DEV_HOST`を渡す。**`0.0.0.0`はIPv4だけに絞られる**ため、
#   従来の全インターフェースに戻すなら`::`を指定する。
DEV_HOST="${ISSUE_DECK_DEV_HOST:-127.0.0.1}"
HOST_ARGS=(-H "$DEV_HOST")
if [ -n "${ISSUE_DECK_DEV_HOST:-}" ]; then
  echo "開発サーバーの待ち受けアドレスを ${DEV_HOST} に固定します（ISSUE_DECK_DEV_HOST の指定）。" >&2
else
  echo "開発サーバーの待ち受けアドレスを ${DEV_HOST} に固定します（既定・#1526）。tailnetからは tailscale serve のURLで見えます。外へ出すときは ISSUE_DECK_DEV_HOST=:: を指定してください。" >&2
fi

# 待ち受けがループバックに閉じているか。閉じているならLANアクセス設定を行っても届かない（後述）。
dev_host_is_loopback() {
  case "$1" in
    127.* | ::1 | '[::1]' | localhost) return 0 ;;
    *) return 1 ;;
  esac
}

# 同一LAN上の別端末（スマホ等）からsslip.io経由でアクセスできるよう、
# Windows側のポートフォワーディングをベストエフォートで設定する（失敗してもdevサーバー起動は続行する）。
#
# ワンクリック起動（scripts/start-local-session.sh）から始まったセッションでは
# ISSUE_DECK_SKIP_LAN_SETUP=1 が環境変数として届く。この経路（wt.exeで開いたタブ）では
# UACを承認しても待ちから戻らず、devサーバーが起動しないまま止まるため行わない（#1094）。
#
# **待ち受けがループバックに閉じているときも行わない（#1526）。** 転送先が
# `<WSLのIP>:<ポート>` なので、閉じたままフォワーディングだけ設定しても繋がらず、
# **繋がらない理由はWindows側にもWSL側にも出ない。** 設定しない旨と開け方をここで案内する。
if dev_host_is_loopback "$DEV_HOST"; then
  echo "LANアクセス設定は行いません（待ち受けが ${DEV_HOST} に閉じているため、ポートフォワーディングを設定しても届きません）。LAN内の別端末から見るときは ISSUE_DECK_DEV_HOST=0.0.0.0 を指定して起動し直してください。" >&2
elif [ "${ISSUE_DECK_SKIP_LAN_SETUP:-0}" != "0" ]; then
  echo "LANアクセス設定はスキップします（LAN内の別端末から見る場合は scripts/setup-lan-access.sh ${PORT} を実行してください）。" >&2
else
  bash "$(dirname "${BASH_SOURCE[0]}")/setup-lan-access.sh" "${PORT}" || echo "警告: LANアクセス設定に失敗しました。localhostでの確認は引き続き可能です。" >&2
fi

# tailnetへの公開（`tailscale serve`・#1265）を張り直す（#1363）。
#
# **開発サーバーだけが停止すると、公開のほうも撤去される。** アイドルで回収された（#1223）
# 開発サーバーのポートは転送先（`localhost:<ポート>`）に待ち受けが無くなるため、
# `scripts/reap-dev-servers.sh`が2巡（既定で約2分）で孤児として撤去する（#1403）。
# ところが公開を張るのはセッションの起動経路（`run-issue-session.sh`・`start-preview-dev.sh`）
# だけで、**案内している起こし直し（`cd <worktree> && pnpm dev`）にはその一手が無かった。**
# その結果、localhostでは見えるのにtailnetのURL（issue-deckの画面に出たまま）は死んだままになり、
# `23.preview-required`で別端末から画面を見る導線が切れていた。
#
# **手で叩き直す経路はこのスクリプトだけで完結させる**（待ち受けの既定と同じ考え方・#1526）。
# `tailscale serve`の公開は同じ内容なら何度張っても同じなので、セッションの起動経路から
# 呼ばれて二重に張っても害は無い。
#
# **待ち受けを開けているときは張らない。** serveはtailnetアドレスを具体的に掴むため、
# `::`（全インターフェース）を要求する`next dev`より先に張ると`EADDRINUSE`で起動できなくなる
# （順序の詳細はdocs/multi-agent/local-quick-start.md）。開けているならtailnetからは直接見える。
#
# `tailscale serve`が使えないホスト（メインPCのWSL等）では黙って何もしない。
# 公開そのものを止めたいときは`ISSUE_DECK_TAILNET_PUBLISH=0`を渡す。
if [ "${ISSUE_DECK_TAILNET_PUBLISH:-1}" = "0" ]; then
  echo "tailnetへの公開は行いません（ISSUE_DECK_TAILNET_PUBLISH=0 の指定）。" >&2
elif ! dev_host_is_loopback "$DEV_HOST"; then
  echo "tailnetへの公開は行いません（待ち受けが ${DEV_HOST} のため、serveを張ると next dev が EADDRINUSE で起動できません）。tailnetからは直接この待ち受けに届きます。" >&2
else
  PREVIEW_URL="$(tailscale_serve_publish "$PORT" || true)"
  if [ -n "$PREVIEW_URL" ]; then
    # **文面は run-issue-session.sh と同じにする。** 起動ログからtailnetのURLを拾う案内
    # （scripts/start-issue.sh がプロンプトへ書き込む）が、この行を目印にしている。
    echo "開発サーバーをtailnetへ公開しました: $PREVIEW_URL" >&2
  else
    echo "情報: tailnetへの公開は行いません（tailscale serveが使えないホストです）。" >&2
  fi
fi

SMEE_PID=""
if [ -n "${GITHUB_WEBHOOK_PROXY_URL:-}" ]; then
  pnpm exec smee --url "${GITHUB_WEBHOOK_PROXY_URL}" --target "http://127.0.0.1:${PORT}/api/webhooks/github" &
  SMEE_PID=$!
  trap 'kill "${SMEE_PID}" 2>/dev/null || true' EXIT
else
  echo "GITHUB_WEBHOOK_PROXY_URL が未設定のため、smee client は起動しません。" >&2
fi

# HOST_ARGS は必ず `-H <アドレス>` の2要素（#1526で既定を持たせたため空にならない）。
next dev -p "${PORT}" "${HOST_ARGS[@]}"
