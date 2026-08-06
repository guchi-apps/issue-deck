#!/usr/bin/env node
// Issue #567: スマホのイシュー詳細画面（/dashboard?mscreen=issue-detail&missue=<id>）を
// 撮影するには、GitHubのIssue番号ではなく、アプリのクライアント側で使われるIssue識別子
// （src/lib/github/issue-mapper.tsのdbIssueToDisplayIssueが`String(githubIssueId)`として
// 組み立てるもの。Prismaの主キー`Issue.id`＝cuidとは別物）が必要なため、
// scripts/seed-ci-db.mjs が投入したCI用ダミーIssueのgithubIssueIdをDBから取得するだけの
// スクリプト（#550, #571: 以前は誤ってPrismaの`id`を返しており、`issues.find`が常に一致せず
// mobile-issue-detailの撮影がホーム画面にフォールバックしていた。develop側で#550として、
// このブランチ側で#571として同じ不具合を独立に修正していた）。
//
// 使い方: DATABASE_URL=mysql://... node scripts/ci-get-sample-issue-id.mjs
// 出力: 見つかったIssueのgithubIssueId（1件）を標準出力に1行で出力する。
//
// REPOSITORY_GITHUB_ID は scripts/seed-ci-db.mjs の値と一致させること。

import { PrismaClient } from "@prisma/client";

const REPOSITORY_GITHUB_ID = 900000001;

const prisma = new PrismaClient();

async function main() {
  const issue = await prisma.issue.findFirst({
    where: { repository: { githubRepositoryId: REPOSITORY_GITHUB_ID } },
    orderBy: { number: "asc" },
  });

  if (!issue) {
    console.error(
      "Error: CI用ダミーIssueが見つかりませんでした。先にscripts/seed-ci-db.mjsを実行してください。",
    );
    process.exitCode = 1;
    return;
  }

  console.log(issue.githubIssueId.toString());
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
