# VPSメモリの自動計測（サブPC→SSH）

**いつ読むか**: 本番issue-deckのメモリ増加を調べる・計測の仕組みを触るとき。#4256。[production-memory.md](production-memory.md)の「再発したときに見るもの」を、ユーザーがVPSでコマンドを実行して貼る手作業なしで取るための仕組み。

## 構成

```
サブPC: scripts/vps-memory-probe.mjs --(Tailscale・SSH `ssh vps`・読み取りのみ)--> VPS(/proc)
   └ --post → POST /api/integrations/vps-memory/samples (DISPATCH_SECRET) → VpsMemorySampleテーブル
ChatGPT → AIDE(MCP) → GET /api/integrations/vps-memory (共有トークン) ← AIDE側のツールは別Issue
```

- 計測は**読み取り専用**。再起動・デプロイ・設定変更はしない。`sudo`も使わない。`/proc/<pid>/environ`は開かず、環境変数の値は出さない
- **常時実行はしない**（timer・serviceを作っていない）。連続計測は`--duration`で必ず終わる

## 実行方法（サブPC）

```bash
node scripts/vps-memory-probe.mjs --once                       # 1回。JSON Linesを標準出力へ
node scripts/vps-memory-probe.mjs --duration 600 --interval 30 # 600秒間、30秒ごと（上限3600秒・間隔は10秒以上）
node scripts/vps-memory-probe.mjs --once --post                # issue-deckへも送る
```

- 接続先は`~/.ssh/config`の`Host vps`（既定。`VPS_MEMORY_SSH_HOST`か`--host`で変更）。新しいSSH・Tailscale認証は要らない
- `--post`は`~/.config/issue-deck/dispatch.env`の`APP_BASE_URL`・`DISPATCH_SECRET`を使う（poller・`fetch-issue-images.sh`と同じ）
- 計測対象は版（`node_modules/next`）が一致する`next-server`。`--next-version`で上書きできる
- 負荷: 1回のSSHで`/proc`を数ファイル読むだけ。1回の打ち切りは20秒

## 取れるもの・取れないもの

| 項目 | 取得 | 備考 |
| --- | --- | --- |
| PID・採取時刻・起動時刻・稼働時間 | ○ | 区間キーは`<pid>-<起動時刻tick>` |
| RSS・VmHWM・スレッド数 | ○ | `/proc/<pid>/status`（他ユーザーのプロセスでも読める） |
| ホストの空き（MemAvailable）・Swap | ○ | `/proc/meminfo` |
| Nodeの実行引数 | △ | 実プロセスのcmdlineはタイトルが書き換わり読めないため、`deploy/ecosystem.config.js`の`node_args`を`source:"repo-config"`で返す |
| heapTotal/heapUsed/external・PM2再起動数・smaps上位 | ×（`unavailableFields`に`permission`） | `github-user`のPM2・`smaps`は`guchi`で読めず`sudo`はパスワード要求。`guchi-apps/vps`側のsudoers整備後に追加する（別Issue） |

PM2の再起動は、PID・起動時刻の変化（区間の切り替わり）として検知する。

## 別プロセスを混ぜない・欠測の扱い

- ピークは区間（`segments`）ごとに返す。デプロイ・再起動でPIDか起動時刻が変われば別区間
- VPSには`next-server`が複数常駐し、権限なしではissue-deckのPIDを確定できない。**前回の区間が生きていればそれを追い、無ければ版が一意に一致するときだけ選ぶ。絞れなければ`ambiguous_process`**（他アプリの値を返さない）
- 取得できなかった回も`status:"unavailable"`＋`reason`で残す（0や空にしない）: `ssh_failed`・`timeout`・`permission_denied`・`remote_failed`・`parse_error`・`process_not_found`・`ambiguous_process`
- **サブPC停止・計測未実行**はサンプルが届かないので、APIの`latestAgeSeconds`（最新サンプルからの経過秒）と`lastSuccessAt`（最後に取得できた時刻）で読む。古い値を現在値と読まない

## 読み取りAPI（AIDE向け）

`GET /api/integrations/vps-memory?hours=24&history=1`（`Authorization: Bearer`）。`latest`・`lastSuccessAt`・`latestAgeSeconds`・`segments`（区間ごとの観測RSS最大・VmHWM）を返し、`history=1`で採取サンプルも返す。`hours`は1〜168。

- 鍵は共有トークン`ISSUE_DECK_VPS_MEMORY_TOKEN`（無ければ環境変数`VPS_MEMORY_READ_SECRET`）。**設定画面の共有トークンへ登録する**（[shared-token-api.md](shared-token-api.md)）。未設定の間は`503 not_configured`
- 書き込み（`POST .../samples`）は`DISPATCH_SECRET`。読み取り鍵では書き込めない

## 保存期間と停止方法

- 保存は**7日・2万件まで**。受信のたびに超過分を古い順に削除する
- 停止: 連続計測は`Ctrl-C`か`--duration`の満了。常駐するものは無い。記録を消すときは`VpsMemorySample`を削除する

## 残り（別Issueで追う）

- 共有トークン登録と本番での取得確認: [issue-deck#4269](https://github.com/guchi-apps/issue-deck/issues/4269)（`71.manual-step`）。本番デプロイとマイグレーション適用後に、サブPCで `--once --post` を実行し、読み取りAPIが200を返して最新サンプルを含むことを確認する。未実施の間は #4256 を完了扱いにしない
- AIDEのMCPツール: [aide#608](https://github.com/guchi-apps/aide/issues/608)
- heap・PM2再起動数・smaps上位とPID確定: [vps#287](https://github.com/guchi-apps/vps/issues/287)（sudoers整備）
