# Mac mini でディスパッチを受ける（#5528）

サブPC（`subpc`）と並ぶ2台目の常時起動ホストとして、Mac mini（識別子 `macmini`、画面上の表記は MacMini）でジョブを受け取るための導入手順。仕組み・設定項目の意味は [docs/multi-agent/subpc-dispatch.md](../../docs/multi-agent/subpc-dispatch.md) と [deploy/subpc/](../subpc/) を正とし、ここには macOS で異なる点だけを書く。

> スクリプト群のOS差（`/proc`・`ss`・`systemctl`・`setsid`・`reboot` など）は `scripts/lib/os-compat.sh` で吸収している（#5529。[docs/multi-agent/subpc-dispatch.md](../../docs/multi-agent/subpc-dispatch.md)「ホストのOSの違いの吸収」）。

## 前提

- `~/apps/issue-deck` に本体を clone 済み。共有知識は `~/apps/_docs` に clone 済み（セッション起動時に `--add-dir` で渡されるため、ディレクトリ名は `_docs` 固定）。
- Homebrew で次を導入済み。スクリプトは bash 4 以降と GNU 版のコマンドを前提にしているため、plist で PATH の先頭に置く。

  ```bash
  brew install bash coreutils util-linux flock jq tmux node pnpm
  ```

- Tailscale に参加済みで、Claude Code にサインイン済み。

## 手順

```bash
# 1. 設定ファイル（chmod 600。実値はコミットしない）
mkdir -p ~/.config/issue-deck
install -m 600 ~/apps/issue-deck/deploy/macmini/dispatch.env.example ~/.config/issue-deck/dispatch.env
# APP_BASE_URL・DISPATCH_SECRET・PROGRESS_REPORT_SECRET・WAKE_LISTEN_ADDR を埋める
$EDITOR ~/.config/issue-deck/dispatch.env

# 2. 申告だけ試す（ジョブは取らない）
PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/util-linux/bin:/opt/homebrew/bin:$PATH" \
  ~/apps/issue-deck/deploy/macmini/run-with-env.sh \
  ~/apps/issue-deck/scripts/subpc-dispatch-poller.sh --announce-only

# 3. launchd へ登録（ユーザー単位。sudo 不要）
mkdir -p ~/Library/LaunchAgents ~/Library/Logs/issue-deck
for name in dispatch-poller dispatch-wake; do
  sed "s|__HOME__|$HOME|g" \
    ~/apps/issue-deck/deploy/macmini/com.guchi-apps.issue-deck.$name.plist \
    > ~/Library/LaunchAgents/com.guchi-apps.issue-deck.$name.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.guchi-apps.issue-deck.$name.plist
done
```

LaunchAgent はユーザーのログインセッションで動く。再起動後も動かすため、Mac mini は自動ログインを有効にしておく（サブPCの `loginctl enable-linger` に当たる）。

## 運用

| やりたいこと | コマンド |
|---|---|
| 状態を見る | `launchctl print gui/$(id -u)/com.guchi-apps.issue-deck.dispatch-poller` |
| 設定を変えたあと再起動する | `launchctl kickstart -k gui/$(id -u)/com.guchi-apps.issue-deck.dispatch-poller` |
| 止める | `launchctl bootout gui/$(id -u)/com.guchi-apps.issue-deck.dispatch-poller` |
| ログを読む | `tail -n 50 ~/Library/Logs/issue-deck/dispatch-poller.log` |

サブPCの `journalctl --user -u issue-deck-dispatch-poller` に当たるのは、このログファイル。

## サブPCとの違い

| 項目 | サブPC | Mac mini |
|---|---|---|
| 常駐 | systemd --user（`deploy/subpc/*.service`） | launchd の LaunchAgent（このディレクトリの plist） |
| 設定の読み込み | `EnvironmentFile=` | `run-with-env.sh` |
| ログ | journald | `~/Library/Logs/issue-deck/*.log` |
| ログアウト後の常駐 | `loginctl enable-linger` | 自動ログイン |
| ホスト名 | 省略時は `hostname -s`（`subpc`） | `DISPATCH_HOST_NAME=macmini` を必ず明示する |
