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

#1121は「メモリ2GBのVPSにNext.jsが10本常駐しており、既定のヒープ上限では各プロセスが使わない
メモリを抱え込む」という全アプリ共通の対応で、8アプリへ同じ`128MB / 320M`を適用したもの。
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

## 変更したときの反映

`ecosystem.config.js`の変更は`pm2 restart`では反映されず、`pm2 start <file> --env production`での
読み込み直しが必要。issue-deckのデプロイ（`.github/workflows/deploy.yml`）は毎回
`pm2 delete issue-deck` → `pm2 start deploy/ecosystem.config.js --env production`を実行するため、
**mainへマージしてデプロイが通れば自動で反映される**。VPS上での手作業は要らない。

## 再発したときに見るもの

VPS上（PM2の実行ユーザーは`github-user`）で次を確認する。issue-deckのリポジトリ側からは分からない。

```bash
pm2 describe issue-deck   # 再起動回数（restarts）・現在のメモリ・落ちた理由
pm2 logs issue-deck --lines 100 --nostream
```

- ログに`FATAL ERROR: Reached heap limit Allocation failed`があれば**ヒープ上限が狭い**側。
  `node_args`の`--max-old-space-size`を上げる。
- ログに異常が無いのに`restarts`だけ増えるなら**PM2が`max_memory_restart`で殺している**側。
  `pm2 describe`のメモリが閾値付近まで伸びているはず。閾値を上げるか、伸びる原因を潰す。

## 値を触るときの注意

- VPSは**メモリ2GBでNext.jsが10本常駐**している。`max_memory_restart`は「暴走時の保険」であって
  目標値ではないが、全アプリで無闇に上げると保険として機能しなくなる。issue-deckだけ他8アプリ
  （`128MB / 320M`）より緩いのは、上の実測にもとづく意図的な差分。
- 再起動ループは通知がうるさいだけでなく、**プロセス内キャッシュが毎回空になる**
  （[`src/lib/github/issue-run-cache.ts`](../src/lib/github/issue-run-cache.ts)は
  「プロセスが入れ替わればキャッシュは空になる」前提で組んである）ため、GitHub APIの消費が増え、
  処理中のリクエストも落ちる。放置してよい種類の警告ではない。
