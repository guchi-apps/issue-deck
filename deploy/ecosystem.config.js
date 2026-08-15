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
      // メモリ2GBのVPS上でNext.jsが10本常駐しており、Nodeの既定ヒープ上限
      // （1プロセスあたり約1006MB）ではGCが働かず各プロセスが数百MBを抱え込む。
      // 上限を明示して早めにGCさせる（#1121）。max_memory_restart は暴走時の保険。
      //
      // ただし#1121が全アプリ共通で入れた 128MB / 320M は issue-deck には狭すぎ、
      // PM2が max_memory_restart で殺し続けて再起動ループになっていた（#1546）。
      // issue-deckは常駐10本のうち実測RSSが最大のアプリで、ログイン画面を返すだけの
      // ローカル実測でも500リクエスト後に206MBへ達し、320Mまでの余裕がほとんど無い。
      // ヒープ上限を128MB→256MBに広げてもRSSは同水準（500リクエスト後203MB）で、
      // 広げること自体のメモリ増はほぼ無い。値の根拠と再発時の調べ方は
      // docs/production-memory.md を参照。
      node_args: "--max-old-space-size=256",
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "development",
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3111,
      },
    },
  ],
};
