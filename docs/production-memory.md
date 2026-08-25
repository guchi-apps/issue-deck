# 本番（PM2）のメモリ設定

本番のissue-deckはVPS上のPM2で`next start`として常駐している（[`deploy/ecosystem.config.js`](../deploy/ecosystem.config.js)）。
このファイルの`node_args`（Nodeのヒープ上限）と`max_memory_restart`（PM2がプロセスを殺す閾値）を
触るとき、値の根拠が分からないと安全側にも危険側にも動かせないため、経緯と実測値をここに残す。

## PM2再起動検知の通知はどこから来るか

VPS側のリポジトリ（`guchi-apps/vps`）の`scripts/pm2-monitor.sh`がcronで**5分ごと**に動き、
`pm2 jlist`の`restart_time`を前回値（`/var/lib/vps-monitor/pm2-restarts`）と比較している。
増えていればSignalyへ「⚠️ PM2再起動検知: issue-deck」を送る。つまり通知が5分おきに届く状態は、
**issue-deckのプロセスが5分に1回以上落ちて再起動している**ことを意味する。

デプロイ（`.github/workflows/deploy.yml`）は`pm2 delete` → `pm2 start`で入れ替えるため
`restart_time`が0に戻る。デプロイ自体でこの通知が出ることはない。

## 経緯

| 時期 | 設定 | 何が起きたか |
| --- | --- | --- |
| #1121 以前 | ヒープ上限なし（既定 約1006MB） / `max_memory_restart: 512M` | 再起動ループなし |
| #1121（[guchi-apps/vps#62](https://github.com/guchi-apps/vps/issues/62)の一環） | `--max-old-space-size=128` / `320M` | issue-deckだけ再起動ループになり、PM2再起動検知が5分おきに届いた（#1546） |
| #1546 | `--max-old-space-size=256` / `512M` | ヒープ上限の明示（#1121の意図）は残しつつ、殺す閾値を#1121以前の値へ戻した |
| #2331（2026-08-25） | `--max-old-space-size=256` / `768M` | 512Mでも足りず7〜8分ごとの再起動になった。**リークではなく、平常時のピーク（実測506MB）が512Mに接していた**ため閾値を上げた |

#1121は「メモリ2GBのVPSにNext.jsが10本常駐しており、既定のヒープ上限では各プロセスが使わない
メモリを抱え込む」という全アプリ共通の対応で、8アプリへ同じ`128MB / 320M`を適用したもの。

> **この「2GB」は現在の実態と合わない。** #2331時点の`free -m`はVPS全体で`total 3910MB`
> （空き`available 1362MB`・Swap使用536MB）だった。#1121が前提にした数字のままドキュメントに
> 残っていたもので、閾値を決めるときは実測（`free -m`）を見ること。
issue-deckは**実測RSSが10本中で最大（当時200MB）**のアプリで、他アプリで問題にならなかった
320Mが唯一足りなかった。#1121のissue本文自身が「128MBが狭すぎる場合は再起動ループになる」と
デプロイ後の確認事項に挙げていたケースにあたる。

## 実測値（#1546・サブPCでのローカル実測）

`pnpm build`した本番ビルドを`next start`で起動し、未ログインのトップ（ログイン画面）へ
100リクエストずつ投げてRSSを測ったもの。GitHub APIも認証済みの画面も通らない**最低限の負荷**での値。

| リクエスト数 | ヒープ上限128MB | ヒープ上限256MB |
| --- | ---: | ---: |
| 起動直後 | 152 MB | 156 MB |
| 100 | 165 MB | 166 MB |
| 300 | 181 MB | 188 MB |
| 500 | 206 MB | 203 MB |

読み取れること。

- ログイン画面を返すだけで500リクエスト後に**RSS 200MB超**まで伸び、頭打ちになっていない。
  閾値320Mに対する余裕は100MB少々しかなく、実運用（GitHubのGraphQL応答、画像アップロード
  最大10MB、ブラウザからの複数の定期ポーリング）を足せば普通に超える。
- **ヒープ上限を128MB→256MBに広げてもRSSはほぼ変わらない**（206MB→203MB）。この負荷では
  ヒープ上限がRSSの支配要因ではないため、広げること自体でVPSのメモリが増えるわけではない。
  一方で「大きなJSONの処理中に128MBのヒープを使い切って落ちる」経路は消せる。

そのため#1546では、`max_memory_restart`を#1121以前の`512M`へ戻すことを主な対処とし、
ヒープ上限も256MBへ広げた（どちらの原因でも再起動が止まるようにした）。

## 実測値（#2331・本番VPSでの実測）

#1546の実測はサブPCでの最低限の負荷だったため、実運用のRSSがどこで頭打ちになるのかは
分かっていなかった。#2331では**本番のプロセスそのもの**を30秒ごとに10分ぶん測った。

```
21:51:07 pid=544696 rss=284MB     ← 起動直後
21:51:38 pid=544696 rss=472MB
21:52:08 pid=544696 rss=448MB
21:53:39 pid=544696 rss=491MB
21:54:09 pid=544696 rss=506MB     ← ここでPM2が殺した
21:55:09 pid=545388 rss=376MB     ← pidが変わる＝再起動
21:56:10 pid=545388 rss=477MB
21:57:10 pid=545388 rss=384MB
22:00:12 pid=545388 rss=379MB
22:01:13 pid=545388 rss=401MB
```

読み取れること。

- **RSSは376〜506MBを上下しており、増え続けてはいない**。GCのたびに380MB台へ戻る。
  リークなら閾値を上げても周期が伸びるだけだが、そうではなかった
- 殺されたのは506MBに達した直後で、**512Mが平常時のピークに接していた**だけ
- したがって**閾値を上げても実使用量は増えない**。すでにその量を使っており、殺されるのを止める
  だけになる。VPSの空きは同時点で1.3GBあり、観測ピーク506MBに対して768Mなら260MBの余裕が残る

同時点の`pm2 describe issue-deck`は`Used Heap 127.76MiB` / `Heap Size 217.15MiB`で、
RSS 481MBとの差**約264MBはヒープ外**（Prismaのクエリエンジン・undiciのバッファ・コード領域）。
`--max-old-space-size`を触ってもこの264MBは減らないので、ヒープ上限は256MBのまま据え置いた。

## 変更したときの反映

`ecosystem.config.js`の変更は`pm2 restart`では反映されず、`pm2 start <file> --env production`での
読み込み直しが必要。issue-deckのデプロイ（`.github/workflows/deploy.yml`）は毎回
`pm2 delete issue-deck` → `pm2 start deploy/ecosystem.config.js --env production`を実行するため、
**mainへマージしてデプロイが通れば自動で反映される**。VPS上での手作業は要らない。

## 再発したときに見るもの

VPS上（PM2の実行ユーザーは`github-user`）で次を確認する。issue-deckのリポジトリ側からは分からない。

**`pm2`は必ず`github-user`として実行する。** `guchi`のまま叩くとプロセス一覧が空
（`pm2 pid issue-deck`が何も返さない）になるうえ、`guchi`用のPM2デーモンが新しく起動する
（`guchi-apps/vps`の`docs/tips.md`）。起動してしまったら`pm2 kill`で消す。

```bash
sudo su github-user -s /bin/bash -c 'pm2 describe issue-deck'   # 再起動回数・現在のメモリ
sudo su github-user -s /bin/bash -c 'pm2 logs issue-deck --lines 200 --nostream'
```

### 1. どちらの機構で落ちているか

- ログに`FATAL ERROR: Reached heap limit Allocation failed`があれば**ヒープ上限が狭い**側。
  `node_args`の`--max-old-space-size`を上げる。
- ログに異常が無いのに`restarts`だけ増えるなら**PM2が`max_memory_restart`で殺している**側。
  `pm2 describe`のメモリが閾値付近まで伸びているはず。
- どちらでもなく`journalctl -k`にOOM killerの行があるなら**VPS全体のメモリ不足**で、
  issue-deck単体の設定では直らない。

  ```bash
  sudo journalctl -k --since "-6 hours" | grep -iE "out of memory|oom-kill|killed process"
  free -m
  ```

### 2. 増え方の形（頭打ちかリークか）

**`max_memory_restart`側だったときは、閾値を上げる前に必ずこれを見る。** #1546は形を見ずに
閾値を上げたため、同じ症状が10日で再発した（#2331）。頭打ちなら閾値を上げれば終わりだが、
リークなら周期が伸びるだけになる。

プロセス自身が`[memory]`行を出す（[`src/lib/process-memory-watch.ts`](../src/lib/process-memory-watch.ts)。#2331）。
**それまでの最大値を16MB以上更新したときだけ**出るので、頭打ちなら起動直後に数行出て静かになり、
リークなら延々と行が増える。

```bash
sudo su github-user -s /bin/bash -c 'pm2 logs issue-deck --lines 500 --nostream' | grep '\[memory\]'
```

間隔と更新幅は`MEMORY_WATCH_INTERVAL_SECONDS`（既定60秒。`0`で見張りを止める）と
`MEMORY_WATCH_STEP_MB`（既定16MB）で変えられる。どちらも未設定で問題ないので、
`.env`にもGitHubのsecret/variableにも置いていない。

ログが足りない・PM2が殺した瞬間を見たいときは、外から30秒ごとに測る（10分ぶん）。
`pid`が変わった行が再起動の瞬間で、その直前のRSSが殺されたときの値になる。

```bash
sudo su github-user -s /bin/bash -c 'for i in $(seq 1 21); do PID=$(pm2 pid issue-deck); RSS=$(ps -o rss= -p "$PID" 2>/dev/null); echo "$(date +%H:%M:%S) pid=$PID rss=$(( ${RSS:-0} /1024))MB"; sleep 30; done'
```

## 値を触るときの注意

- VPSは**Next.jsが10本常駐**している（メモリは#2331時点の実測で約3.9GB。上の注記のとおり
  「2GB」は古い）。`max_memory_restart`は「暴走時の保険」であって目標値ではないが、全アプリで
  無闇に上げると保険として機能しなくなる。issue-deckだけ他8アプリ（`128MB / 320M`）より
  緩いのは、上の実測にもとづく意図的な差分。
- **閾値は「観測したピーク」ではなく「観測したピーク＋余裕」で決める。** #2331の実測ピークは
  506MBだが、画像アップロード（最大10MB）や巡回3本が重なる山はこの10分に入っていない可能性が
  ある。768Mは観測ピークに対して約1.5倍を確保した値。
- 再起動ループは通知がうるさいだけでなく、**プロセス内キャッシュが毎回空になる**
  （[`src/lib/github/issue-run-cache.ts`](../src/lib/github/issue-run-cache.ts)は
  「プロセスが入れ替わればキャッシュは空になる」前提で組んである）ため、GitHub APIの消費が増え、
  処理中のリクエストも落ちる。放置してよい種類の警告ではない。
