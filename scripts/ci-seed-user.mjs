#!/usr/bin/env node
// CI（GitHub Actions）の無人実行でPlaywright等からスクリーンショットを撮る際に使う、
// 固定のログインバイパス対象ユーザーをDBにupsertするだけのスクリプト。
// DATABASE_URL が必要なため、実際にCIワークフローから呼ばれるのは
// MySQLサービスコンテナが用意された後（#258側）を想定している。
//
// supabaseUserId の値は src/lib/ci-auth-bypass.ts の CI_BYPASS_SUPABASE_USER_ID と
// 必ず一致させること（プレーンJSのスクリプトのためTSファイルを直接importせず、
// 値をこのファイルに直書きしている）。

import { PrismaClient } from "@prisma/client";

const CI_BYPASS_SUPABASE_USER_ID = "ci-screenshot-bot";

// 実在のGitHub User ID（常に正の整数）と衝突しないよう、負の値を使う。
const CI_PLACEHOLDER_GITHUB_USER_ID = -1;

const db = new PrismaClient();

async function main() {
  const user = await db.user.upsert({
    where: { supabaseUserId: CI_BYPASS_SUPABASE_USER_ID },
    update: {},
    create: {
      supabaseUserId: CI_BYPASS_SUPABASE_USER_ID,
      githubUserId: CI_PLACEHOLDER_GITHUB_USER_ID,
      githubLogin: "ci-screenshot-bot",
      name: "CI Screenshot Bot",
    },
  });

  console.log(`CIバイパス用ユーザーをupsertしました: id=${user.id} githubLogin=${user.githubLogin}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
