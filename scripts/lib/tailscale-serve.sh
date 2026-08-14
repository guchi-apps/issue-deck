#!/usr/bin/env bash
# 開発サーバーをtailnet内だけに出す（#1265）。
#
# `tailscale serve`がlocalhostへプロキシする形にすると、公開範囲をTailscaleのACLが保証するため
# firewallは要らない。ただし**バインドは変わる**（#1329）。serveは公開したポートを自ノードの
# tailnetアドレスで実際にlistenするため、全インターフェース（`::`）を要求する`next dev`とは
# 同じポートで両立しない。**serveが出ているポートでは開発サーバーを`127.0.0.1`へ閉じる**
# （判定は `tailscale_serve_published`・使う側は scripts/dev.sh と run-issue-session.sh）。
#
# 実測して分かっていること（#1261に記録）。
#
# - HTTPS証明書が未有効（`CertDomains: None`）なので、既定モード（443/HTTPS）は使えない。
#   **`--http=<ポート>`一択。**
# - **生IPではアクセスできない**（404）。serveはHostヘッダーで振り分けるため、
#   出すURLは必ずDNS名（`http://<ホスト名>.<tailnet>.ts.net:<ポート>`）。
# - `sudo`が要る（`OperatorUser: None`）。`guchi`のNOPASSWDはmysql系だけなので、
#   `/etc/sudoers.d/tailscale-serve`に`NOPASSWD: /usr/bin/tailscale serve *`を足してある。
#   **足りていないホストではパスワード待ちで固まらないよう`sudo -n`で叩き、失敗したら諦める。**
#
# 呼び出し側（run-issue-session.sh・reap-dev-servers.sh・dev.sh）で共有する。
# **どの関数もセッションを止めない。** 公開できなくても実装は続く。

# tailscale serveが使えるか。使えないホスト（メインPCのWSL等）では黙って何もしない。
tailscale_serve_available() {
  command -v tailscale >/dev/null 2>&1 || return 1
  sudo -n /usr/bin/tailscale serve status >/dev/null 2>&1
}

# 自ホストのMagicDNS名（末尾のドットは落とす）。取れなければ空。
tailscale_serve_hostname() {
  tailscale status --json 2>/dev/null |
    python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
name = (d.get("Self") or {}).get("DNSName") or ""
print(name.rstrip("."))' 2>/dev/null || true
}

# 公開する。成功したらURLを標準出力へ返す。失敗したら何も出さずに1を返す。
tailscale_serve_publish() {
  local port="$1" host
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 1
  tailscale_serve_available || return 1

  sudo -n /usr/bin/tailscale serve --bg --http="$port" "localhost:$port" >/dev/null 2>&1 || return 1

  host="$(tailscale_serve_hostname)"
  [[ -n "$host" ]] || return 1
  printf 'http://%s:%s' "$host" "$port"
}

# 撤去する。**セッションが落ちても設定だけ残るため、回収側からも同じ関数を呼ぶ。**
tailscale_serve_unpublish() {
  local port="$1"
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 0
  tailscale_serve_available || return 0
  sudo -n /usr/bin/tailscale serve --http="$port" off >/dev/null 2>&1 || return 0
}

# 現在serveされているHTTPポートを1行ずつ返す（孤児の回収に使う）。
tailscale_serve_ports() {
  tailscale_serve_available || return 0
  sudo -n /usr/bin/tailscale serve status --json 2>/dev/null |
    python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
# `TCP`に載るポートのうち、HTTPとして扱っているものだけを拾う。形が変わっても落とさない
for port, conf in (d.get("TCP") or {}).items():
    if isinstance(conf, dict) and conf.get("HTTP"):
        print(port)' 2>/dev/null || true
}

# そのポートが今`tailscale serve`で公開されているか（#1329）。
#
# 公開されているポートで`next dev`を既定（`::`）のまま起こすと`EADDRINUSE`で落ちるため、
# 開発サーバー側が待ち受けを`127.0.0.1`へ倒す判断に使う。**使えないホストでは常に偽**なので、
# メインPCのWSLなど`tailscale serve`が無い環境の挙動は変わらない。
tailscale_serve_published() {
  local port="$1" served
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 1
  while read -r served; do
    if [[ "$served" == "$port" ]]; then
      return 0
    fi
  done < <(tailscale_serve_ports)
  return 1
}
