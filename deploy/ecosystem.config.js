const path = require("node:path");

// 本番ポートはデプロイ着手時（M7想定）に vps リポジトリのアプリ一覧を確認のうえ確定する。
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
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "development",
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: process.env.PORT,
      },
    },
  ],
};
