const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "issue-deck",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      cwd: path.resolve(__dirname, ".."),
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      // VPS上でNext.jsが10本常駐しており、Nodeの既定ヒープ上限（1プロセスあたり約1006MB）
      // ではGCが働かず各プロセスが数百MBを抱え込む。上限を明示して早めにGCさせる（#1121）。
      // max_memory_restart は暴走時の保険。
      //
      // ただし#1121が全アプリ共通で入れた 128MB / 320M は issue-deck には狭すぎ、
      // PM2が max_memory_restart で殺し続けて再起動ループになっていた（#1546 → 512M）。
      // その512Mでも足りず、2026-08-25に再び7〜8分ごとの再起動になった（#2331）。
      //
      // #2331の本番実測（30秒ごと10分）では、RSSは376〜506MBを**上下**しており、
      // 増え続けてはいない——GCのたびに380MB台へ戻る。506MBに達した直後にPM2が殺しており、
      // 512Mが平常時のピークに接していただけだった。**閾値を上げても実使用量は増えない**
      // （すでにその量を使っており、殺されるのを止めるだけ）。VPSの実メモリは約3.9GBで、
      // 同時点の空きは約1.3GBあった。観測ピーク506MBに対して余裕を持たせて768Mにする。
      //
      // ヒープ上限256MBは据え置く。#2331のログに `FATAL ERROR: Reached heap limit` は
      // 出ておらず、ヒープ側は原因ではない（RSS 481MBのうちヒープは217MBで、残り約264MBは
      // Prismaのクエリエンジン・undiciのバッファ・コード領域といったヒープ外）。
      // 値の根拠と再発時の調べ方は docs/production-memory.md を参照。
      node_args: "--max-old-space-size=256",
      max_memory_restart: "768M",
      // PM2 は max_memory_restart による再起動やサーバー再起動後の resurrect で
      // プロセスを起動し直す際、pm2 start 時に指定した --env production を失って
      // 既定の env にフォールバックすることがある。development で起動されると
      // Apache のプロキシ先（127.0.0.1:3111）と食い違って 503 になるため、
      // 既定の env も本番と同じ値にしておく。
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3111,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3111,
      },
    },
  ],
};
